import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../helpers/serve';
import { openSession } from '../../src/capture/session';
import { explore } from '../../src/capture/explore';
import { captureAll } from '../../src/capture/capture-all';
import { loadManifest, readJson, saveManifest } from '../../src/pack/io';
import { RunPaths } from '../../src/pack/paths';
import {
  HookSettingsSchema,
  LockFileSchema,
  RunLogSchema,
  type Scenario,
} from '../../src/pack/schemas';
import { latestRun } from '../../src/orchestrate/report';
import { childEnv, DONE, PASS, readScenarioState, writeScenario } from '../helpers/fake-claude';

const bin = path.resolve('bin/site');
const HEADER = 'page:index#s01-header';
/** the fixture's index page: six sections and the page itself */
const UNITS = 7;
let server: Awaited<ReturnType<typeof serveStatic>>;
let base: string;
let work: string;

/**
 * the first builder call sleeps long enough to be killed; every call after it answers at once.
 * the hooks are skipped (they are proven in hooks.test.ts and each one costs this file a real
 * verify), except where a test asks for them on the sleeping call: the hard-kill test is about
 * what the Stop hook does for a worker whose orchestrator died under it.
 */
const scenario = (opts: { hooksWhileSleeping?: boolean } = {}): Scenario => ({
  calls: [
    {
      when: { role: 'builder', unit: HEADER, round: 1 },
      do: { sleepMs: 20_000, output: DONE, honourHooks: opts.hooksWhileSleeping ?? false },
    },
    { when: { role: 'builder' }, times: 1000, do: { output: DONE, honourHooks: false } },
    { when: { role: 'reviewer' }, times: 1000, do: { output: PASS, honourHooks: false } },
  ],
});

/**
 * the compile checks the cli cannot turn off. the fake builder writes nothing, so the project
 * stays a stub, and `npx tsc --noEmit` and `npx next lint` would both fail in it and block every
 * unit. npx prefers node_modules/.bin, so a pair of shell stubs there is what makes the checks
 * pass here without a real install; a check that really fails is covered in round.test.ts. each
 * stub appends its name and its cwd, so a test can prove both ran in the project the cli passed.
 */
async function stubChecks(project: string, log: string): Promise<void> {
  const binDir = path.join(project, 'node_modules', '.bin');
  await fs.mkdir(binDir, { recursive: true });
  for (const name of ['tsc', 'next']) {
    const file = path.join(binDir, name);
    await fs.writeFile(file, `#!/bin/sh\necho "${name} $PWD" >> '${log}'\nexit 0\n`);
    await fs.chmod(file, 0o755);
  }
}

interface Setup {
  root: string;
  project: string;
  /** the project as a round sees it: the checks run in its realpath (macos /var is /private/var) */
  realProject: string;
  scenarioFile: string;
  checkLog: string;
  env: NodeJS.ProcessEnv;
  args: (...extra: string[]) => string[];
}

/** a fresh pack, a stub project and a scenario of its own, so the tests do not share a queue */
async function setup(name: string, opts: { hooksWhileSleeping?: boolean } = {}): Promise<Setup> {
  const dir = path.join(work, name);
  const root = path.join(dir, 'pack');
  await fs.cp(base, root, { recursive: true });
  const project = path.join(dir, 'project');
  const checkLog = path.join(dir, 'checks.log');
  await stubChecks(project, checkLog);
  const scenarioFile = await writeScenario(path.join(dir, 'scenario.json'), scenario(opts));
  return {
    root,
    project,
    realProject: await fs.realpath(project),
    scenarioFile,
    checkLog,
    // `claude` resolves to the fake by name: the fake's dir is first on the child's PATH
    env: childEnv(scenarioFile, true),
    args: (...extra: string[]) => [
      'build',
      '--pack',
      root,
      '--project',
      project,
      '--target',
      server.url,
      '--parallel',
      '1',
      '--rounds',
      '2',
      ...extra,
    ],
  };
}

/** the fake records a call before it sleeps, so this is the header's worker running, not starting */
async function waitForHeaderBuilder(s: Setup): Promise<void> {
  const until = Date.now() + 90_000;
  for (;;) {
    try {
      const state = await readScenarioState(s.scenarioFile);
      if (state.calls.some((c) => c.role === 'builder' && c.unit === HEADER)) return;
    } catch {
      /* the fake has not written its state yet */
    }
    if (Date.now() > until) throw new Error('the header never started building');
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** every process still in a build's own process group: the run itself, and anything it did not detach */
async function groupMembers(pgid: number): Promise<string[]> {
  const r = await execa('pgrep', ['-g', String(pgid)], { reject: false });
  return r.stdout.split('\n').filter((line) => line.trim() !== '');
}

/**
 * every process whose command line names this pack: the run (`--pack <root>`) and the workers
 * it started (`--add-dir <root>`, `--settings <root>/runs/...`). scoped to one test's own pack,
 * so another test's worker, or another checkout's, is never counted.
 */
async function pgrepFor(root: string): Promise<string[]> {
  const r = await execa('pgrep', ['-f', root], { reject: false });
  return r.stdout.split('\n').filter((line) => line.trim() !== '');
}

async function statusesOf(root: string): Promise<string[]> {
  const m = await loadManifest(root);
  return Object.values(m.units).map((u) => u.status);
}

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  const session = await openSession({});
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'site-pack-build-cli-'));
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'site-build-cli-'));
  try {
    await explore({
      root: base,
      url: `${server.url}/`,
      depth: 0,
      scope: [],
      session,
      states: false,
    });
    await captureAll({ root: base, session });
  } finally {
    await session.close();
  }
}, 600_000);
afterAll(async () => {
  await server.close();
  await fs.rm(base, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
});

describe('site plan, build, report', () => {
  it('prints the plan', async () => {
    const s = await setup('plan');
    const r = await execa(bin, ['plan', '--pack', s.root], { env: s.env, reject: false });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('7 units');
    expect(r.stdout).toContain('captured 7');
    expect(r.stdout).toContain('ready now: 6');
    expect(r.stdout).toContain('0 open questions');
  });

  it('is stopped mid-round, leaves a resumable manifest, and the next run finishes the job', async () => {
    const s = await setup('sigterm');
    const first = execa(bin, s.args(), { env: s.env, reject: false });
    await waitForHeaderBuilder(s);
    expect(await statusesOf(s.root)).toContain('building');
    first.kill('SIGTERM');
    const killed = await first;
    expect(killed.exitCode, killed.stderr).toBe(2);
    expect(killed.stdout).toContain('stopping');
    expect(killed.stdout).toContain('1 interrupted');
    // the run cleaned up after itself: the unit is back, with its round given back, and the
    // lock is released, so the next run has nothing to restore
    const m = await loadManifest(s.root);
    expect(m.units[HEADER]).toMatchObject({ status: 'captured', rounds: 0 });
    for (const [id, u] of Object.entries(m.units)) expect(u.status, id).toBe('captured');
    await expect(fs.stat(path.join(s.root, 'runs', '.lock'))).rejects.toThrow();
    const run1 = (await latestRun(s.root))!;
    const log1 = await readJson(RunLogSchema, new RunPaths(s.root, run1).log);
    expect(log1.endedAt).not.toBeNull();
    expect(log1.rounds.map((r) => r.result)).toEqual(['interrupted']);
    expect(log1.restored).toEqual([]);
    // the fake was told to stop: the killed call is on record and its scenario entry is spent
    const state = await readScenarioState(s.scenarioFile);
    expect(state.uses[0]).toBe(1);

    const second = await execa(bin, s.args(), { env: s.env, reject: false });
    expect(second.exitCode, second.stderr + second.stdout).toBe(0);
    expect(second.stdout).toContain('7 passed, 0 blocked, 0 interrupted');
    const after = await loadManifest(s.root);
    for (const [id, u] of Object.entries(after.units)) expect(u.status, id).toBe('passed');
    const run2 = (await latestRun(s.root))!;
    expect(run2).not.toBe(run1);
    const log2 = await readJson(RunLogSchema, new RunPaths(s.root, run2).log);
    expect(log2.restored).toEqual([]);
    expect(log2.options).toEqual({ parallel: 1, rounds: 2, threshold: null });
    expect(log2.rounds).toHaveLength(UNITS);
    // the interrupted round was given back, so the header runs round 1 again in round-1
    expect(after.units[HEADER]!.rounds).toBe(1);
    await expect(fs.stat(new RunPaths(s.root, run2).roundDir(HEADER, 1))).resolves.toBeTruthy();
    await expect(fs.stat(new RunPaths(s.root, run2).roundDir(HEADER, 2))).rejects.toThrow();
    // both compile checks ran once per round, in the project the cli was given
    const ran = (await fs.readFile(s.checkLog, 'utf8')).trim().split('\n');
    expect(ran).toHaveLength(2 * UNITS);
    expect(new Set(ran)).toEqual(new Set([`tsc ${s.realProject}`, `next ${s.realProject}`]));

    // one summary line, build's own, and the report path under it: the cli no longer prints a
    // second line of the same counts on top of it
    const out = second.stdout.trim().split('\n').filter(Boolean);
    expect(out.slice(-2)).toEqual([
      'done: 7 passed, 0 blocked, 0 interrupted',
      `report: ${new RunPaths(s.root, run2).report}`,
    ]);
    expect(out.filter((l) => l.includes('passed,'))).toHaveLength(1);

    const report = await execa(bin, ['report', '--pack', s.root], { env: s.env, reject: false });
    expect(report.exitCode, report.stderr).toBe(0);
    expect(report.stdout.trim()).toBe(new RunPaths(s.root, run2).report);
    const text = await fs.readFile(report.stdout.trim(), 'utf8');
    expect(text).toContain('## passed (7)');
    expect(text).toContain(`# build ${run2}`);
  }, 900_000);

  it('resolves a relative --pack, so the inner gate fires and the artefacts are absolute', async () => {
    // the readme teaches `--pack sites/<host>`, and every other test here passes an absolute
    // mkdtemp path. the hooks run with the rebuilt project as their cwd, so a relative pack
    // reaches them as a path under the project: the stop hook exits 2 on every hold without
    // ever running verify, and the recorded artefacts come out relative against the schema.
    const dir = path.join(work, 'relative');
    const root = path.join(dir, 'pack');
    await fs.cp(base, root, { recursive: true });
    // one unit to build, so the round is one builder and one failing check rather than a
    // whole pack. its page stays in the manifest: a section is verified through its page's
    // url, and the page itself never becomes ready while the section has not passed
    const m = await loadManifest(root);
    for (const id of Object.keys(m.units))
      if (id !== HEADER && id !== 'page:index') delete m.units[id];
    m.units['page:index']!.dependsOn = [HEADER];
    await saveManifest(root, m);
    const project = path.join(dir, 'project');
    // tsc passes and next lint fails, so the round fails after the builder and its hooks and
    // the unit blocks at the budget with the artefacts a reader is pointed at
    const binDir = path.join(project, 'node_modules', '.bin');
    await fs.mkdir(binDir, { recursive: true });
    for (const [name, exit] of [
      ['tsc', 0],
      ['next', 1],
    ] as const) {
      const file = path.join(binDir, name);
      await fs.writeFile(file, `#!/bin/sh\nexit ${exit}\n`);
      await fs.chmod(file, 0o755);
    }
    // the fake honours the hooks here: the stop hook is the inner gate, and its state file is
    // the only proof it ran at all
    const scenarioFile = await writeScenario(path.join(dir, 'scenario.json'), {
      calls: [{ when: { role: 'builder' }, times: 1000, do: { output: DONE } }],
    });
    const r = await execa(
      bin,
      ['build', '--pack', 'pack', '--project', 'project', '--target', server.url, '--rounds', '1'],
      { cwd: dir, env: childEnv(scenarioFile, true), reject: false },
    );
    expect(r.exitCode, r.stderr + r.stdout).toBe(1);
    const run = (await latestRun(root))!;
    const roundDir = new RunPaths(root, run).roundDir(HEADER, 1);
    // the stop hook ran its own verify against the pack the relative name pointed at, and
    // wrote the state that says how often it held this round
    const stopState = JSON.parse(await fs.readFile(path.join(roundDir, 'stop-hook.json'), 'utf8'));
    expect(stopState.lastVerdict).toBe('pass');
    const after = await loadManifest(root);
    expect(after.units[HEADER]!.status).toBe('blocked');
    const artefacts = after.units[HEADER]!.artefacts ?? [];
    expect(artefacts.length).toBeGreaterThan(0);
    for (const a of artefacts) expect(path.isAbsolute(a), a).toBe(true);
    // and the run log names the pack and the project as resolved paths, not as typed
    const log = await readJson(RunLogSchema, new RunPaths(root, run).log);
    expect(log.root).toBe(await fs.realpath(root).catch(() => root));
    expect(path.isAbsolute(log.project)).toBe(true);
  }, 900_000);

  it('survives a hard kill: the orphaned worker ends at its next hook and the next run restores the unit', async () => {
    // the run gets a group of its own so the kill reaches everything in it. the worker is not
    // in it: every worker is spawned `detached: true` so a timed-out one can be killed as a
    // group with the grandchildren holding its pipes (the 2.5 hour round of the second real
    // run). the trade-off is this: a SIGKILL of the run no longer takes the worker down, and
    // what ends the worker instead is its own next hook reading runs/.lock
    const s = await setup('sigkill', { hooksWhileSleeping: true });
    const first = execa(bin, s.args('--threshold', '0.002'), {
      env: s.env,
      reject: false,
      detached: true,
    });
    const pgid = first.pid!;
    expect(pgid).toBeGreaterThan(0);
    await waitForHeaderBuilder(s);
    // the worker of this pack, running and not in the run's group
    const workers = (await pgrepFor(s.root)).filter((pid) => pid !== String(pgid));
    expect(workers.length, 'the header builder is running').toBeGreaterThan(0);
    const before = await groupMembers(pgid);
    expect(before).toContain(String(pgid));
    for (const pid of workers) {
      expect(before, 'a worker leads a process group of its own').not.toContain(pid);
    }

    process.kill(-pgid, 'SIGKILL');
    const killed = await first;
    expect(killed.signal).toBe('SIGKILL');
    const until = Date.now() + 30_000;
    let left = await groupMembers(pgid);
    while (left.length && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
      left = await groupMembers(pgid);
    }
    // the run's own group is empty; the browser it opened is not in it and this cannot see it:
    // playwright spawns chromium `detached: process.platform !== "win32"`, so it is in a group
    // of its own and exits when the debugging pipe to the dead parent closes
    expect(left).toEqual([]);
    // the worker outlived the run, which is the trade-off stated above
    expect(await pgrepFor(s.root)).toEqual(workers);

    // and it ends on its own: its scripted sleep runs out, its Stop hook reads runs/.lock,
    // finds the pid it names dead and lets it stop instead of holding it through a verify
    // against a dev server nobody will stop
    const ends = Date.now() + 20_000 + 60_000;
    let alive = await pgrepFor(s.root);
    while (alive.length && Date.now() < ends) {
      await new Promise((r) => setTimeout(r, 250));
      alive = await pgrepFor(s.root);
    }
    expect(alive, 'the orphaned worker never ended').toEqual([]);
    const call = (await readScenarioState(s.scenarioFile)).calls.find(
      (c) => c.role === 'builder' && c.unit === HEADER && c.round === 1,
    )!;
    // it ran to its end rather than being killed mid-sleep, and the hook held it no times
    expect(call.endedAt).not.toBe(call.startedAt);
    expect(call.stopBlocks).toBe(0);
    const run0 = (await latestRun(s.root))!;
    const roundDir = new RunPaths(s.root, run0).roundDir(HEADER, 1);
    // the worker really was given the hook: the settings file the round wrote for it names it,
    // and this scenario entry honours what it is given
    const settings = await readJson(HookSettingsSchema, path.join(roundDir, 'settings.json'));
    expect(settings.hooks.Stop![0]!.hooks[0]!.command).toContain(`hook stop --pack '${s.root}'`);
    // the hook that holds writes the state file first; the hook that releases an orphan
    // returns before it, so a missing file is the release itself
    await expect(fs.stat(path.join(roundDir, 'stop-hook.json'))).rejects.toThrow(/ENOENT/);

    // a hard kill runs no cleanup: the unit is left in flight and the lock still names the run
    const m = await loadManifest(s.root);
    expect(m.units[HEADER]).toMatchObject({ status: 'building', rounds: 1 });
    const run1 = (await latestRun(s.root))!;
    const lock = await readJson(LockFileSchema, path.join(s.root, 'runs', '.lock'));
    expect(lock).toMatchObject({ pid: pgid, run: run1 });
    const log1 = await readJson(RunLogSchema, new RunPaths(s.root, run1).log);
    expect(log1.endedAt).toBeNull();
    expect(log1.rounds).toEqual([]);

    // the next run reclaims the dead holder's lock, restores the unit and finishes the pack
    const second = await execa(bin, s.args('--threshold', '0.002'), { env: s.env, reject: false });
    expect(second.exitCode, second.stderr + second.stdout).toBe(0);
    expect(second.stdout).toContain(`restored to captured after a killed run: ${HEADER}`);
    expect(second.stdout).toContain('7 passed, 0 blocked, 0 interrupted');
    const after = await loadManifest(s.root);
    for (const [id, u] of Object.entries(after.units)) expect(u.status, id).toBe('passed');
    // the killed round was given back on the restore, so the header passes in round 1 again
    expect(after.units[HEADER]).toMatchObject({ status: 'passed', rounds: 1 });
    const run2 = (await latestRun(s.root))!;
    expect(run2).not.toBe(run1);
    const log2 = await readJson(RunLogSchema, new RunPaths(s.root, run2).log);
    expect(log2.restored).toEqual([HEADER]);
    expect(log2.options).toEqual({ parallel: 1, rounds: 2, threshold: 0.002 });
    expect(log2.rounds).toHaveLength(UNITS);
    expect(log2.rounds.find((r) => r.unitId === HEADER)).toMatchObject({
      round: 1,
      result: 'passed',
    });
    const paths2 = new RunPaths(s.root, run2);
    await expect(fs.stat(paths2.roundDir(HEADER, 1))).resolves.toBeTruthy();
    await expect(fs.stat(paths2.roundDir(HEADER, 2))).rejects.toThrow();
    await expect(fs.stat(path.join(s.root, 'runs', '.lock'))).rejects.toThrow();
  }, 900_000);
});
