import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../helpers/serve';
import { openSession } from '../../src/capture/session';
import { explore } from '../../src/capture/explore';
import { captureAll } from '../../src/capture/capture-all';
import { loadManifest, readJson } from '../../src/pack/io';
import { RunPaths } from '../../src/pack/paths';
import { RunLogSchema } from '../../src/pack/schemas';
import { ERROR_CODES } from '../../src/pack/defaults';
import { build, QuestionsOpenError } from '../../src/orchestrate/build';
import { acquireLock, LockError } from '../../src/orchestrate/lock';
import { nextUnits, scopeOf, transition } from '../../src/orchestrate/state';
import { ManifestStore } from '../../src/orchestrate/store';
import { writeReport } from '../../src/orchestrate/report';
import {
  childEnv,
  DONE,
  FAKE_CLAUDE,
  PASS,
  readScenarioState,
  writeScenario,
} from '../helpers/fake-claude';
import type { Scenario } from '../../src/pack/schemas';

/**
 * the browser a run opens is the real one; `failClose` is the one fault a test injects, to
 * prove the cleanup on the way out carries on past a step that throws. the sessions handed out
 * while it is set are kept so the test can close them for real afterwards.
 */
const sessions = vi.hoisted(() => ({ failClose: false, real: [] as { close(): Promise<void> }[] }));
vi.mock('../../src/capture/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/capture/session')>();
  return {
    ...actual,
    openSession: async (opts: Parameters<typeof actual.openSession>[0]) => {
      const session = await actual.openSession(opts);
      if (!sessions.failClose) return session;
      sessions.real.push(session);
      return { ...session, close: () => Promise.reject(new Error('the browser is gone')) };
    },
  };
});

const HERO = 'page:index#s02-hero-know-before-you-go';
// round.ts waits 30 s before retrying a crashed round, read once from here on the first crash;
// the wait itself is proven in round.test.ts, and a build test must not spend it
process.env['SITE_CRASH_RETRY_MS'] = '0';
let server: Awaited<ReturnType<typeof serveStatic>>;
let base: string;
let work: string;

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  const session = await openSession({});
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'site-pack-build-'));
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'site-build-'));
  try {
    // two pages, no states: index and about, every section a unit
    await explore({
      root: base,
      url: `${server.url}/`,
      depth: 1,
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

async function setup(name: string, scenario: Scenario) {
  const dir = path.join(work, name);
  const root = path.join(dir, 'pack');
  await fs.cp(base, root, { recursive: true });
  const project = path.join(dir, 'project');
  await fs.mkdir(project, { recursive: true });
  const scenarioFile = await writeScenario(path.join(dir, 'scenario.json'), scenario);
  const lines: string[] = [];
  const options = {
    root,
    project,
    target: server.url,
    claude: FAKE_CLAUDE,
    checks: [],
    turns: { builder: 8, reviewer: 4 },
    timeouts: { builderMs: 60_000, reviewerMs: 60_000 },
    backoffMs: [20],
    stopHookBlocks: 1,
    models: { builder: 'sonnet', reviewer: 'haiku' },
    env: childEnv(scenarioFile),
    log: (line: string) => {
      lines.push(line);
    },
  };
  return { root, project, scenarioFile, options, lines };
}

const everyBuilder = (extra: Record<string, unknown> = {}) => ({
  when: { role: 'builder' as const },
  times: 1000,
  do: { output: DONE, honourHooks: false, ...extra },
});
const everyReviewer = () => ({
  when: { role: 'reviewer' as const },
  times: 1000,
  do: { output: PASS, honourHooks: false },
});

describe('build', () => {
  it('does nothing over a manifest where every unit passed, and says so in the report', async () => {
    const { root, scenarioFile, options } = await setup('noop', { calls: [] });
    const store = new ManifestStore(root);
    await store.load();
    await store.update((m) => {
      for (const id of Object.keys(m.units)) {
        transition(m, id, { type: 'build_started' });
        transition(m, id, { type: 'verify_started' });
        transition(m, id, { type: 'verify_passed', score: 0 });
        transition(m, id, { type: 'review_passed' });
      }
    });
    const r = await build({ ...options, run: 'r0' });
    expect(r).toMatchObject({ run: 'r0', passed: [], blocked: [], interrupted: [], restored: [] });
    expect(r.log.rounds).toEqual([]);
    expect(r.log.endedAt).not.toBeNull();
    // no worker was ever asked for anything: the fake never ran, so it wrote no state
    await expect(fs.stat(`${scenarioFile}.state.json`)).rejects.toThrow();
    const units = Object.keys((await loadManifest(root)).units);
    const text = await fs.readFile(await writeReport(root, 'r0'), 'utf8');
    expect(text).toContain('# build r0');
    expect(text).toContain('- rounds run: 0');
    expect(text).toContain(`## passed (${units.length})`);
    expect(text).toContain('## blocked (0)');
    expect(text).toContain('## not started (0)');
    await expect(fs.stat(path.join(root, 'runs', '.lock'))).rejects.toThrow();
  }, 300_000);

  it('works the queue in dependency order, two scopes at a time, never two units of one scope', async () => {
    // the two units the scheduler has to pair first; their builders sleep long enough that the
    // overlap below is the scheduler's doing and not a matter of timing luck. a scope is a
    // page, a flow, or `chrome` for every page's header, nav and footer, which are one shared
    // layout however many pages render them
    const pair = nextUnits(await loadManifest(base), { parallel: 2 });
    expect(pair).toHaveLength(2);
    const { root, scenarioFile, options } = await setup('order', {
      calls: [
        ...pair.map((unit) => ({
          when: { role: 'builder' as const, unit },
          do: { output: DONE, honourHooks: false, sleepMs: 3_000 },
        })),
        everyBuilder({ sleepMs: 300 }),
        everyReviewer(),
      ],
    });
    const r = await build({ ...options, parallel: 2, rounds: 2, run: 'r1' });
    const m = await loadManifest(root);
    const ids = Object.keys(m.units);
    expect(ids.length).toBeGreaterThan(8);
    expect(r.passed.sort()).toEqual(ids.sort());
    expect(r.blocked).toEqual([]);
    expect(r.interrupted).toEqual([]);
    for (const id of ids) expect(m.units[id]!.status, id).toBe('passed');
    const calls = (await readScenarioState(scenarioFile)).calls.filter((c) => c.role === 'builder');
    const at = (c: (typeof calls)[number]) =>
      [Date.parse(c.startedAt), Date.parse(c.endedAt)] as const;
    for (const a of calls) {
      for (const b of calls) {
        if (a === b || scopeOf(a.unit!) !== scopeOf(b.unit!)) continue;
        const [as, ae] = at(a);
        const [bs, be] = at(b);
        expect(as < be && bs < ae, `${a.unit} and ${b.unit} overlapped`).toBe(false);
      }
    }
    // the pair on two scopes did run at the same time
    expect(scopeOf(pair[0]!)).not.toBe(scopeOf(pair[1]!));
    const first = calls.find((c) => c.unit === pair[0])!;
    const second = calls.find((c) => c.unit === pair[1])!;
    const [fs1, fe1] = at(first);
    const [ss, se] = at(second);
    expect(fs1 < se && ss < fe1, `${pair[0]} and ${pair[1]} never overlapped`).toBe(true);
    // a page's builder starts after every one of its sections finished
    const page = calls.find((c) => c.unit === 'page:index')!;
    for (const c of calls.filter((c) => c.unit!.startsWith('page:index#'))) {
      expect(Date.parse(page.startedAt)).toBeGreaterThanOrEqual(Date.parse(c.endedAt));
    }
    const log = await readJson(RunLogSchema, new RunPaths(root, 'r1').log);
    expect(log.rounds).toHaveLength(ids.length);
    expect(log.endedAt).not.toBeNull();
    expect(log.options).toEqual({ parallel: 2, rounds: 2, threshold: null });
    expect(log.models).toEqual({ builder: 'sonnet', reviewer: 'haiku' });
    const report = await writeReport(root, 'r1');
    const text = await fs.readFile(report, 'utf8');
    expect(text).toContain('# build r1');
    expect(text).toContain('## passed');
    expect(text).toContain('page:index');
    expect(text).toContain('wall time');
    expect(text).toContain('- models: builder sonnet, reviewer haiku');
    // the lock is gone
    await expect(fs.stat(path.join(root, 'runs', '.lock'))).rejects.toThrow();
  }, 900_000);

  it('blocks a unit at the budget and everything that depends on it, goes on with the rest, and resumes after --reopen', async () => {
    const { root, options } = await setup('block', {
      calls: [
        {
          when: { role: 'builder', unit: HERO, round: 1 },
          do: { stdout: 'boom\n', exitCode: 1, honourHooks: false },
        },
        everyBuilder(),
        everyReviewer(),
      ],
    });
    const r = await build({ ...options, parallel: 1, rounds: 1, run: 'r1' });
    expect(r.blocked.sort()).toEqual([HERO, 'page:index'].sort());
    const m = await loadManifest(root);
    expect(m.units[HERO]).toMatchObject({
      status: 'blocked',
      blockedReason: ERROR_CODES.roundsExhausted,
      rounds: 1,
    });
    expect(m.units['page:index']).toMatchObject({
      status: 'blocked',
      blockedReason: ERROR_CODES.dependency,
      rounds: 0,
    });
    expect(m.units['page:index']!.question).toContain(HERO);
    expect(m.units['page:about']!.status).toBe('passed');
    expect(
      m.questions
        .filter((q) => q.answer === undefined)
        .map((q) => q.unit)
        .sort(),
    ).toEqual([HERO, 'page:index'].sort());
    // the open questions stop the next run until answered or reopened
    await expect(build({ ...options, run: 'r2' })).rejects.toThrow(QuestionsOpenError);
    const again = await build({
      ...options,
      parallel: 1,
      rounds: 2,
      run: 'r3',
      reopen: [HERO, 'page:index'],
    });
    expect(again.passed.sort()).toEqual([HERO, 'page:index'].sort());
    expect(again.blocked).toEqual([]);
    const after = await loadManifest(root);
    expect(after.units[HERO]).toMatchObject({ status: 'passed', rounds: 1 });
    expect(after.units['page:index']!.status).toBe('passed');
    expect(after.questions.every((q) => q.answer !== undefined)).toBe(true);
  }, 900_000);

  it('blocks the dependents of a unit an earlier run left blocked, before it starts a worker', async () => {
    // a unit blocked by an earlier run never blocks again in this one, so nothing would ever
    // cascade from it: its dependents would sit captured, never be scheduled (a dependency
    // that is not `passed` is not ready) and never be explained. the queue is squared with the
    // blocks once, at the start
    const { root, options } = await setup('pre-blocked', {
      calls: [everyBuilder(), everyReviewer()],
    });
    const store = new ManifestStore(root);
    await store.load();
    await store.update((m) => {
      transition(m, HERO, {
        type: 'blocked',
        code: ERROR_CODES.roundsExhausted,
        message: '6 rounds without a pass: verify failed',
      });
      // the person read the question and answered it, which is what lets the next build start
      // with the unit still blocked
      for (const q of m.questions) {
        if (q.unit === HERO && q.answer === undefined) {
          q.answer = 'skip it for now';
          q.answeredAt = '2026-09-18T00:00:00.000Z';
        }
      }
    });
    const r = await build({ ...options, parallel: 1, rounds: 1, run: 'r1' });
    expect(r.blocked).toEqual(['page:index']);
    const m = await loadManifest(root);
    expect(m.units['page:index']).toMatchObject({
      status: 'blocked',
      blockedReason: ERROR_CODES.dependency,
      // the cascade never ran a round for it, so its budget is untouched
      rounds: 0,
    });
    expect(m.units['page:index']!.question).toContain(HERO);
    // the unit it depends on is exactly as the earlier run left it
    expect(m.units[HERO]).toMatchObject({ status: 'blocked' });
    // and the rest of the pack is worked as usual: another page is nobody's dependent here
    expect(m.units['page:about']!.status).toBe('passed');
    expect(r.passed).toContain('page:about');
    for (const [id, u] of Object.entries(m.units)) {
      if (id === HERO || id === 'page:index') continue;
      expect(u.status, id).toBe('passed');
    }
  }, 900_000);

  it('cancels the workers on a signal and puts the in-flight unit back without spending its round', async () => {
    const { root, options } = await setup('interrupt', {
      calls: [everyBuilder({ sleepMs: 30_000 }), everyReviewer()],
    });
    const controller = new AbortController();
    const running = build({
      ...options,
      parallel: 1,
      rounds: 2,
      run: 'r1',
      signal: controller.signal,
    });
    const until = Date.now() + 60_000;
    let building: string | undefined;
    while (!building) {
      if (Date.now() > until) throw new Error('nothing ever started building');
      await new Promise((r) => setTimeout(r, 100));
      const m = await loadManifest(root);
      building = Object.keys(m.units).find((id) => m.units[id]!.status === 'building');
    }
    controller.abort();
    const r = await running;
    expect(r.interrupted).toEqual([building]);
    expect(r.passed).toEqual([]);
    expect(r.blocked).toEqual([]);
    // the killed round is not a failed round: the unit goes back with its budget intact
    const m = await loadManifest(root);
    expect(m.units[building]).toMatchObject({ status: 'captured', rounds: 0 });
    const log = await readJson(RunLogSchema, new RunPaths(root, 'r1').log);
    expect(log.endedAt).not.toBeNull();
    expect(log.rounds.map((x) => x.result)).toEqual(['interrupted']);
    await expect(fs.stat(path.join(root, 'runs', '.lock'))).rejects.toThrow();
  }, 300_000);

  it('keeps the cleanup going when a step throws, and reports the run error, not the cleanup', async () => {
    const { root, options, lines } = await setup('cleanup', { calls: [] });
    sessions.failClose = true;
    try {
      // a project that is not there fails the round inside the worker, after the session is
      // open: that error is the run's, and it is the one that comes out
      await expect(
        build({ ...options, project: path.join(root, 'nowhere'), parallel: 1, run: 'r1' }),
      ).rejects.toThrow(/ENOENT/);
    } finally {
      for (const s of sessions.real.splice(0)) await s.close();
      sessions.failClose = false;
    }
    expect(lines.some((l) => l.includes('closing the browser session failed'))).toBe(true);
    // the step after the one that threw still ran
    await expect(fs.stat(path.join(root, 'runs', '.lock'))).rejects.toThrow();
  }, 300_000);

  it('refuses a pack another build holds, and a manifest with an unanswered question', async () => {
    const { root, options } = await setup('refuse', { calls: [] });
    const manifestFile = path.join(root, 'manifest.json');
    const release = await acquireLock(root, 'someone-else');
    const before = await fs.readFile(manifestFile, 'utf8');
    try {
      await expect(build({ ...options, run: 'r1' })).rejects.toThrow(LockError);
      // --reopen is a write like any other: it waits for the lock, so the manifest the holder
      // is working from is exactly as it left it
      await expect(build({ ...options, run: 'r1', reopen: [HERO] })).rejects.toThrow(LockError);
      expect(await fs.readFile(manifestFile, 'utf8')).toBe(before);
      // a budget the measured stop-hook behaviour would defeat is refused before anything is
      // taken: asked for while someone else holds the lock, the answer is still the budget's,
      // which it could not be if the check ran after acquireLock
      await expect(build({ ...options, run: 'r1', stopHookBlocks: 9 })).rejects.toThrow(
        /turn budget: stopHookBlocks 9/,
      );
      await expect(
        build({ ...options, run: 'r1', turns: { builder: 2, reviewer: 4 } }),
      ).rejects.toThrow(/turn budget: builder turns 2/);
    } finally {
      await release();
    }
    const m = await loadManifest(root);
    m.questions.push({ id: 'q-wall', text: 'the pricing page is behind a login; skip it?' });
    await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(m, null, 2));
    await expect(build({ ...options, run: 'r2' })).rejects.toThrow(/1 question unanswered/);
    await expect(build({ ...options, run: 'r2' })).rejects.toThrow(/q-wall/);
    await expect(fs.stat(path.join(root, 'runs', '.lock'))).rejects.toThrow();
  }, 120_000);
});
