import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../helpers/serve';
import { openSession, type Session } from '../../src/capture/session';
import { explore } from '../../src/capture/explore';
import { captureAll } from '../../src/capture/capture-all';
import { loadManifest, readJson } from '../../src/pack/io';
import { ROUND_FILES, RunPaths } from '../../src/pack/paths';
import { RoundRecordSchema, VerifyResultSchema, type RoundRecord } from '../../src/pack/schemas';
import { ERROR_CODES } from '../../src/pack/defaults';
import { siteBin } from '../../src/orchestrate/hooks';
import { openQuestions, restore } from '../../src/orchestrate/state';
import { ManifestStore } from '../../src/orchestrate/store';
import { runRound, workUnit, type RoundContext } from '../../src/orchestrate/round';
import { BUILDER_ALLOWED, shotRuleFor, verifyRuleFor } from '../../src/orchestrate/defaults';
import {
  childEnv,
  DONE,
  FAKE_CLAUDE,
  PASS,
  readScenarioState,
  writeScenario,
} from '../helpers/fake-claude';
import type { Scenario } from '../../src/pack/schemas';

const HERO = 'page:index#s02-hero-know-before-you-go';
// the wait before a crashed round is retried, shortened for the tests. round.ts reads it once,
// on the first crash, so it is set here before any round runs; the default is 30 s, which is
// there so two transient api errors seconds apart do not spend two of a unit's rounds
const CRASH_RETRY_MS = 300;
process.env['SITE_CRASH_RETRY_MS'] = String(CRASH_RETRY_MS);
let server: Awaited<ReturnType<typeof serveStatic>>;
let mutated: Awaited<ReturnType<typeof serveStatic>>;
let session: Session;
let base: string;
let work: string;

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  mutated = await serveStatic(path.resolve('test/fixtures/site-mutated'));
  session = await openSession({});
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'site-pack-round-'));
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'site-round-'));
  await explore({ root: base, url: `${server.url}/`, depth: 0, scope: [], session, states: false });
  await captureAll({ root: base, session });
}, 600_000);
afterAll(async () => {
  await session.close();
  await server.close();
  await mutated.close();
  await fs.rm(base, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
});

/** a fresh copy of the captured pack, a project dir, a scenario, and a context wired to the fake */
async function setup(
  name: string,
  scenario: Scenario,
  opts: { target: string; rounds?: number; checks?: RoundContext['checks']; builderMs?: number },
): Promise<{ ctx: RoundContext; root: string; scenarioFile: string; rounds: RoundRecord[] }> {
  const dir = path.join(work, name);
  const root = path.join(dir, 'pack');
  await fs.cp(base, root, { recursive: true });
  const project = path.join(dir, 'project');
  await fs.mkdir(project, { recursive: true });
  const scenarioFile = await writeScenario(path.join(dir, 'scenario.json'), scenario);
  const store = new ManifestStore(root);
  await store.load();
  const rounds: RoundRecord[] = [];
  const ctx: RoundContext = {
    root,
    project,
    target: opts.target,
    run: new RunPaths(root, 'r1'),
    store,
    session,
    claude: FAKE_CLAUDE,
    site: siteBin(),
    rounds: opts.rounds ?? 6,
    threshold: undefined,
    checks: opts.checks ?? [],
    turns: { builder: 8, reviewer: 4 },
    timeouts: { builderMs: opts.builderMs ?? 60_000, reviewerMs: 60_000 },
    // one alias per role, so the argv the fake records can be checked for each
    models: { builder: 'sonnet', reviewer: 'haiku' },
    backoffMs: [20],
    stopHookBlocks: 1,
    env: childEnv(scenarioFile),
    signal: new AbortController().signal,
    onRound: async (r) => {
      rounds.push(r);
    },
    log: () => {},
  };
  return { ctx, root, scenarioFile, rounds };
}

// the hooks are proven in hooks.test.ts; here every scripted call skips them so a round is
// the orchestrator's own verify and the reviewer, nothing else
const builder = (extra: Record<string, unknown> = {}) => ({
  when: { role: 'builder' as const },
  do: { output: DONE, honourHooks: false, ...extra },
});
const reviewer = (output: unknown = PASS) => ({
  when: { role: 'reviewer' as const },
  do: { output, honourHooks: false },
});

describe('the round', () => {
  it('holds the gate: a builder that claims success over a wrong build fails verify, retries, and blocks at the budget', async () => {
    const { ctx, root, scenarioFile, rounds } = await setup(
      'gate',
      { calls: [builder({}), builder({})] },
      { target: mutated.url, rounds: 2 },
    );
    expect(await workUnit(ctx, HERO)).toBe('blocked');
    const unit = ctx.store.get().units[HERO]!;
    expect(unit).toMatchObject({
      status: 'blocked',
      rounds: 2,
      blockedReason: ERROR_CODES.roundsExhausted,
    });
    expect(unit.question).toContain('2 rounds without a pass');
    expect(unit.question).toContain('pixel');
    expect(unit.artefacts!.some((a) => a.endsWith('verify.json'))).toBe(true);
    expect(unit.artefacts!.some((a) => a.endsWith('.diff.png'))).toBe(true);
    expect(unit.artefacts!.some((a) => a.endsWith(ROUND_FILES.brief))).toBe(true);
    expect(openQuestions(ctx.store.get()).map((q) => q.unit)).toEqual([HERO]);
    // the reviewer was never asked: the builder's claim moved nothing
    const state = await readScenarioState(scenarioFile);
    expect(state.calls.map((c) => c.role)).toEqual(['builder', 'builder']);
    // the allowed tools the builder was actually launched with: the defaults, plus this
    // round's own verify and shot rules naming this pack and this unit and no other, in the
    // nine spellings a model types them (the matcher compares text, so a quoted path needs a
    // quoted rule)
    const allowed = state.calls[0]!.argv[state.calls[0]!.argv.indexOf('--allowedTools') + 1]!;
    const entries = allowed.split(',');
    expect(entries).toEqual([
      ...BUILDER_ALLOWED,
      ...verifyRuleFor(root, HERO),
      ...shotRuleFor(root, HERO),
    ]);
    expect(entries).toContain(`Bash(site verify --pack ${root} --unit ${HERO} *)`);
    expect(entries).toContain(`Bash(site verify --pack "${root}" --unit "${HERO}" *)`);
    expect(entries).toContain(`Bash(site shot --pack ${root} --unit ${HERO} *)`);
    expect(entries).toContain(`Bash(site shot --pack '${root}' --unit ${HERO} *)`);
    expect(entries.filter((e) => e.startsWith('Bash(site '))).toHaveLength(18);
    expect(allowed).not.toContain('Bash(npm run dev');
    expect(allowed).not.toContain('Bash(npx eslint');
    // no rule reaches another pack or another unit, whatever the spelling
    for (const rule of entries.filter((e) => e.startsWith('Bash(site '))) {
      expect(rule, rule).toContain(HERO);
      expect(rule, rule).toContain(root);
    }
    // the round's own shots dir is not in the rule; the brief is where the worker reads it
    const shotBrief = await fs.readFile(
      path.join(ctx.run.roundDir(HERO, 1), ROUND_FILES.brief),
      'utf8',
    );
    expect(shotBrief).toContain(`--out ${path.join(ctx.run.roundDir(HERO, 1), ROUND_FILES.shots)}`);
    expect(rounds.map((r) => [r.round, r.result])).toEqual([
      [1, 'retry'],
      [2, 'blocked'],
    ]);
    const first = await readJson(
      RoundRecordSchema,
      path.join(ctx.run.roundDir(HERO, 1), ROUND_FILES.round),
    );
    expect(first.builder?.outcome).toBe('done');
    expect(first.verify?.verdict).toBe('fail');
    expect(first.verify!.score).toBeGreaterThan(0.001);
    expect(first.reviewer).toBeNull();
    const verify = await readJson(VerifyResultSchema, path.join(root, first.verify!.file));
    expect(verify.verdict).toBe('fail');
    // the second brief carries the first round's verdict and artefacts
    const brief = await fs.readFile(
      path.join(ctx.run.roundDir(HERO, 2), ROUND_FILES.brief),
      'utf8',
    );
    expect(brief).toContain('round 2 of 2');
    expect(brief).toContain('## the previous round');
    expect(brief).toContain('verify failed');
    expect(brief).toContain(path.join(ctx.run.roundDir(HERO, 1), ROUND_FILES.verify));
    // the manifest on disk is the store's: saved after every transition
    expect(
      (await readJson(RoundRecordSchema, path.join(ctx.run.roundDir(HERO, 2), ROUND_FILES.round)))
        .result,
    ).toBe('blocked');
  }, 600_000);

  it('passes a unit only after its own verify and the reviewer both pass', async () => {
    const { ctx, rounds, scenarioFile } = await setup(
      'pass',
      { calls: [builder(), reviewer()] },
      {
        target: server.url,
      },
    );
    expect(await workUnit(ctx, HERO)).toBe('passed');
    expect(ctx.store.get().units[HERO]).toMatchObject({
      status: 'passed',
      rounds: 1,
      lastScore: 0,
    });
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ round: 1, result: 'passed', reason: null });
    expect(rounds[0]!.verify).toMatchObject({ verdict: 'pass', score: 0 });
    expect(rounds[0]!.reviewer?.output).toEqual(PASS);
    const dir = ctx.run.roundDir(HERO, 1);
    for (const f of [
      ROUND_FILES.brief,
      ROUND_FILES.builder,
      ROUND_FILES.settings,
      ROUND_FILES.allowed,
      ROUND_FILES.reviewBrief,
      ROUND_FILES.reviewer,
      ROUND_FILES.round,
    ]) {
      await expect(fs.stat(path.join(dir, f)), f).resolves.toBeTruthy();
    }
    const reviewBrief = await fs.readFile(path.join(dir, ROUND_FILES.reviewBrief), 'utf8');
    expect(reviewBrief).toContain('built the section');
    expect(reviewBrief).toContain('ours.desktop.s02-hero-know-before-you-go.png');
    // each role is launched with its own model alias
    const state = await readScenarioState(scenarioFile);
    const modelOf = (role: string) => {
      const c = state.calls.find((x) => x.role === role)!;
      return c.argv[c.argv.indexOf('--model') + 1];
    };
    expect(modelOf('builder')).toBe('sonnet');
    expect(modelOf('reviewer')).toBe('haiku');
  }, 600_000);

  it('retries a rejected review and hands the reasons to the next builder', async () => {
    const { ctx, rounds } = await setup(
      'reject',
      {
        calls: [
          reviewer({ verdict: 'reject', reasons: ['the image is a placeholder'] }),
          reviewer(),
          builder(),
          builder(),
        ],
      },
      { target: server.url },
    );
    expect(await workUnit(ctx, HERO)).toBe('passed');
    expect(ctx.store.get().units[HERO]!.rounds).toBe(2);
    expect(rounds.map((r) => r.result)).toEqual(['retry', 'passed']);
    expect(rounds[0]!.reason).toContain('the image is a placeholder');
    const brief = await fs.readFile(
      path.join(ctx.run.roundDir(HERO, 2), ROUND_FILES.brief),
      'utf8',
    );
    expect(brief).toContain('the reviewer rejected it for:');
    expect(brief).toContain('- the image is a placeholder');
  }, 600_000);

  it('waits on a rate limit and retries the same round', async () => {
    const { ctx, scenarioFile, rounds } = await setup(
      'limit',
      {
        calls: [
          { when: { role: 'builder' }, do: { rateLimit: true, honourHooks: false } },
          builder(),
          reviewer(),
        ],
      },
      { target: server.url },
    );
    expect(await workUnit(ctx, HERO)).toBe('passed');
    expect(ctx.store.get().units[HERO]!.rounds).toBe(1);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]!.waits).toHaveLength(1);
    expect(rounds[0]!.waits[0]).toMatchObject({ ms: 20 });
    expect(rounds[0]!.waits[0]!.why).toMatch(/429/);
    expect((await readScenarioState(scenarioFile)).calls.map((c) => c.role)).toEqual([
      'builder',
      'builder',
      'reviewer',
    ]);
  }, 600_000);

  it('stops waiting after the cap and fails the round, rather than retrying for ever', async () => {
    const { ctx, rounds } = await setup(
      'capped',
      {
        calls: [
          { when: { role: 'builder' }, times: 99, do: { rateLimit: true, honourHooks: false } },
        ],
      },
      { target: server.url, rounds: 1 },
    );
    expect(await workUnit(ctx, HERO)).toBe('blocked');
    expect(rounds).toHaveLength(1);
    // MAX_RATE_LIMIT_RETRIES waits, then the call is taken at its word and the round fails
    expect(rounds[0]!.waits).toHaveLength(5);
    expect(rounds[0]!.builder?.outcome).toBe('rate_limited');
    expect(rounds[0]!.reason).toContain('builder rate_limited');
    expect(rounds[0]!.verify).toBeNull();
    // the waits cost the unit nothing; the round it failed is the one round it had
    expect(ctx.store.get().units[HERO]!.rounds).toBe(1);
  }, 120_000);

  it('feeds a failing compile check back as a failed round and never runs verify', async () => {
    const { ctx, rounds } = await setup(
      'check',
      { calls: [builder()] },
      {
        target: server.url,
        rounds: 1,
        checks: [
          {
            name: 'tsc',
            command: 'node',
            args: ['-e', 'console.error("src/x.tsx(3,1): error TS2322: nope"); process.exit(2)'],
          },
        ],
      },
    );
    expect(await workUnit(ctx, HERO)).toBe('blocked');
    expect(rounds[0]).toMatchObject({
      result: 'blocked',
      verify: null,
      checks: [{ name: 'tsc', exitCode: 2, ok: false }],
    });
    expect(rounds[0]!.reason).toContain('tsc failed');
    const dir = ctx.run.roundDir(HERO, 1);
    expect(await fs.readFile(path.join(dir, ROUND_FILES.checks), 'utf8')).toContain('TS2322');
    await expect(fs.stat(path.join(dir, ROUND_FILES.verify))).rejects.toThrow();
    expect(ctx.store.get().units[HERO]!.question).toContain('tsc failed');
  }, 120_000);

  it('counts a crashed, a malformed, an exhausted and a timed-out builder as failed rounds', async () => {
    const { ctx, rounds } = await setup(
      'outcomes',
      {
        calls: [
          { when: { round: 1 }, do: { stdout: 'boom\n', exitCode: 1, honourHooks: false } },
          { when: { round: 2 }, do: { resultText: 'done, promise', honourHooks: false } },
          { when: { round: 3 }, do: { subtype: 'error_max_turns', honourHooks: false } },
          { when: { round: 4 }, do: { sleepMs: 5_000, output: DONE, honourHooks: false } },
        ],
      },
      // 2 s, not 500 ms: rounds 1 to 3 need the fake to boot, take the state lock and answer,
      // which has been measured at up to 700 ms under load, and only round 4 is meant to time
      // out. its scripted 5 s sleep still exceeds this by a wide margin
      { target: server.url, rounds: 4, builderMs: 2_000 },
    );
    expect(await workUnit(ctx, HERO)).toBe('blocked');
    expect(rounds.map((r) => r.builder?.outcome)).toEqual([
      'crashed',
      'malformed_output',
      'turns_exhausted',
      'timeout',
    ]);
    expect(rounds.map((r) => r.result)).toEqual(['retry', 'retry', 'retry', 'blocked']);
    expect(rounds.every((r) => r.verify === null)).toBe(true);
    expect(ctx.store.get().units[HERO]!.question).toContain('builder timeout');
  }, 120_000);

  it('retries a builder that crashed twice for different reasons, to the budget, waiting between', async () => {
    // the no-op negative for the runner-defect rule below: two crashes that are not the same
    // crash are two bad rounds, and the unit spends its budget on them as it always has
    const crash = (round: number, message: string) => ({
      when: { round },
      do: { stdout: '', exitCode: 1, stderr: `${message}\n`, honourHooks: false },
    });
    const { ctx, rounds } = await setup(
      'crash-different',
      { calls: [crash(1, 'boom one'), crash(2, 'boom two'), crash(3, 'boom three')] },
      { target: server.url, rounds: 3 },
    );
    const lines: string[] = [];
    ctx.log = (line) => lines.push(line);
    const startedAt = Date.now();
    expect(await workUnit(ctx, HERO)).toBe('blocked');
    expect(rounds.map((r) => r.result)).toEqual(['retry', 'retry', 'blocked']);
    // a crash is the binary or the api, not the build: each retry waits, so two transient
    // errors seconds apart cannot spend a unit's budget in a few seconds
    const waits = lines.filter((l) => l.includes(`waiting ${CRASH_RETRY_MS} ms`));
    expect(waits).toHaveLength(2);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2 * CRASH_RETRY_MS);
    const unit = ctx.store.get().units[HERO]!;
    expect(unit.rounds).toBe(3);
    expect(unit.question).toContain('3 rounds without a pass');
    expect(unit.question).toContain('boom three');
  }, 120_000);

  it('blocks a builder that crashed the same way twice before a tool call, budget or no budget', async () => {
    // measured on the first real run: a flag the binary refused killed every call of every role
    // in about a second, and every unit spent its whole budget of rounds on the same second.
    // the same crash twice with no turn in either is the runner's own defect, and the unit
    // blocks with it as its question instead of retrying
    const { ctx, scenarioFile, rounds } = await setup(
      'crash-same',
      {
        calls: [
          {
            when: { role: 'builder' },
            times: 4,
            do: {
              stdout: '',
              exitCode: 1,
              stderr: 'Error: --json-schema is not a valid JSON Schema\n',
              honourHooks: false,
            },
          },
        ],
      },
      { target: server.url, rounds: 4 },
    );
    expect(await workUnit(ctx, HERO)).toBe('blocked');
    expect(rounds.map((r) => r.result)).toEqual(['retry', 'blocked']);
    const unit = ctx.store.get().units[HERO]!;
    expect(unit.rounds).toBe(2);
    expect(unit.blockedReason).toBe(ERROR_CODES.roundsExhausted);
    expect(unit.question).toContain('the same way twice');
    expect(unit.question).toContain('--json-schema is not a valid JSON Schema');
    // two of the four rounds, and the fake was asked exactly twice
    expect((await readScenarioState(scenarioFile)).calls).toHaveLength(2);
  }, 120_000);

  /** the unit is mid-round, the round is not spent yet, and nothing was decided against it */
  async function expectInterrupted(ctx: RoundContext, rounds: RoundRecord[]): Promise<void> {
    const unit = ctx.store.get().units[HERO]!;
    expect(['building', 'verifying']).toContain(unit.status);
    // and the same on disk: the store saves after every transition, so a run killed here
    // leaves the next one exactly this to restore
    const onDisk = (await loadManifest(ctx.root)).units[HERO]!;
    expect(onDisk.status).toBe(unit.status);
    expect(onDisk.rounds).toBe(unit.rounds);
    expect(unit.lastRoundDir).toBeUndefined();
    expect(unit.blockedReason).toBeUndefined();
    // the round is still counted as in flight; restore is what gives it back
    expect(unit.rounds).toBe(1);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ round: 1, result: 'interrupted' });
    const restored = await ctx.store.update((m) => restore(m));
    expect(restored).toEqual([HERO]);
    expect(ctx.store.get().units[HERO]).toMatchObject({ status: 'captured', rounds: 0 });
  }

  /** the run comes back against a healthy target: the same round number, from a clean round dir */
  async function expectResumes(ctx: RoundContext, rounds: RoundRecord[]): Promise<void> {
    const resumed: RoundContext = {
      ...ctx,
      target: server.url,
      signal: new AbortController().signal,
    };
    expect(await workUnit(resumed, HERO)).toBe('passed');
    expect(ctx.store.get().units[HERO]).toMatchObject({ status: 'passed', rounds: 1 });
    expect(rounds.map((r) => [r.round, r.result])).toEqual([
      [1, 'interrupted'],
      [1, 'passed'],
    ]);
    // the interrupted round's dir was reused, not skipped over
    await expect(fs.stat(ctx.run.roundDir(HERO, 2))).rejects.toThrow();
    const record = await readJson(
      RoundRecordSchema,
      path.join(ctx.run.roundDir(HERO, 1), ROUND_FILES.round),
    );
    expect(record).toMatchObject({ round: 1, result: 'passed' });
  }

  it('gives back a round the abort killed under the builder, and resumes it as the same round', async () => {
    const { ctx: base, rounds } = await setup(
      'interrupt-builder',
      {
        calls: [
          { when: { role: 'builder' }, do: { sleepMs: 30_000, output: DONE, honourHooks: false } },
          builder(),
          reviewer(),
        ],
      },
      { target: server.url },
    );
    const abort = new AbortController();
    const ctx: RoundContext = { ...base, signal: abort.signal };
    const timer = setTimeout(() => abort.abort(), 500);
    expect(await workUnit(ctx, HERO)).toBe('interrupted');
    clearTimeout(timer);
    expect(rounds[0]!.builder?.outcome).toBe('crashed');
    expect(rounds[0]!.verify).toBeNull();
    await expectInterrupted(ctx, rounds);
    await expectResumes(ctx, rounds);
  }, 600_000);

  it('gives back a round the abort killed under verify, whatever verify then said', async () => {
    // the target is the wrong site, so verify fails while the run is going down: that failure
    // is the interrupt's, and it must not spend the round or move the unit
    const { ctx: base, rounds } = await setup(
      'interrupt-verify',
      { calls: [builder(), builder(), reviewer()] },
      { target: mutated.url },
    );
    const abort = new AbortController();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const ctx: RoundContext = {
      ...base,
      signal: abort.signal,
      // the builder has just returned, so the wait lands inside verify's own browser work
      log: (line) => {
        if (line.includes('builder done')) timers.push(setTimeout(() => abort.abort(), 1_000));
      },
    };
    expect(await workUnit(ctx, HERO)).toBe('interrupted');
    for (const t of timers) clearTimeout(t);
    expect(rounds[0]!.builder?.outcome).toBe('done');
    await expectInterrupted(ctx, rounds);
    await expectResumes(ctx, rounds);
  }, 600_000);

  it('runs one round at a time and refuses a unit that is not captured', async () => {
    const { ctx } = await setup(
      'illegal',
      { calls: [builder(), reviewer()] },
      {
        target: server.url,
      },
    );
    await ctx.store.transition(HERO, { type: 'build_started' });
    await expect(runRound(ctx, HERO)).rejects.toThrow(/build_started is not legal from building/);
  }, 120_000);
});
