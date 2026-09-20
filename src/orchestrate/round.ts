import fs from 'node:fs/promises';
import path from 'node:path';
import type { ZodType } from 'zod';
import type { Session } from '../capture/session';
import { DEFAULT_PIXEL_GATE, ERROR_CODES, VIEWPORT_NAMES } from '../pack/defaults';
import { readJson, writeJson } from '../pack/io';
import { ROUND_FILES, RunPaths, VERIFY_FILE } from '../pack/paths';
import {
  ReviewerOutputSchema,
  RoundRecordSchema,
  VerifyResultSchema,
  WorkerOutputSchema,
  type RoundRecord,
  type VerifyResult,
} from '../pack/schemas';
import { verifyUnit } from '../verify/verify';
import { builderBrief, reviewerBrief, type BriefInput, type PreviousRound } from './brief';
import {
  BUILDER_ALLOWED,
  BUILDER_TOOLS,
  ORCHESTRATE,
  REVIEWER_ALLOWED,
  REVIEWER_TOOLS,
  shotRuleFor,
  verifyRuleFor,
  type Check,
} from './defaults';
import { writeHookSettings } from './hooks';
import { allowedFilesFor } from './layout';
import type { Event } from './state';
import type { ManifestStore } from './store';
import { runInGroup, runWorker, type WorkerResult } from './worker';

export interface RoundContext {
  root: string;
  project: string;
  target: string;
  run: RunPaths;
  store: ManifestStore;
  /** the orchestrator's own browser for verify */
  session: Session;
  claude: string;
  /** bin/site for the hooks */
  site: string;
  rounds: number;
  /** `--threshold`; undefined defers to the unit's override and the default gate */
  threshold: number | undefined;
  checks: Check[];
  turns: { builder: number; reviewer: number };
  timeouts: { builderMs: number; reviewerMs: number };
  /** the model alias per role (`sonnet`, `haiku`); absent means the binary's own default */
  models: { builder?: string; reviewer?: string };
  backoffMs: number[];
  stopHookBlocks: number;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** every finished round, in order; build.ts appends it to run.json */
  onRound: (record: RoundRecord) => Promise<void>;
  log: (line: string) => void;
}

/**
 * consecutive rate-limited retries of one worker call before the round is failed with the
 * reason instead. RATE_LIMIT_PATTERN matches text as well as api statuses, so a worker that
 * quotes a page's own "too many requests" copy looks rate limited every time it runs: without
 * a cap the round waits and retries for ever and the run never moves. with the default backoff
 * these five waits span over an hour, long enough for a spent usage window to reopen.
 */
const MAX_RATE_LIMIT_RETRIES = 5;

const now = () => new Date().toISOString();

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // the listener comes off whichever way the wait ends: a run's signal outlives every wait
    // taken under it, and node warns once eleven listeners have piled up on one emitter
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function worstScore(v: VerifyResult): number | null {
  const scores = VIEWPORT_NAMES.map((vp) => v.pixel[vp]?.score).filter(
    (s): s is number => s !== undefined,
  );
  return scores.length ? Math.max(...scores) : null;
}

/** one line for the record, the question and the next brief */
function summaryLine(v: VerifyResult): string {
  const parts: string[] = [];
  for (const vp of VIEWPORT_NAMES) {
    const p = v.pixel[vp];
    if (p) parts.push(`${vp} pixel ${(p.score * 100).toFixed(3)}%`);
  }
  if (v.styles.length) parts.push(`${v.styles.length} style findings`);
  if (v.animations.length) parts.push(`${v.animations.length} animation findings`);
  if (v.missing.length) parts.push(`missing: ${v.missing.join(', ')}`);
  return parts.join(', ') || 'no findings';
}

/** what the last finished round left for the next brief, from the manifest's lastRoundDir */
export async function previousRound(
  ctx: RoundContext,
  unitId: string,
): Promise<PreviousRound | null> {
  const rel = ctx.store.get().units[unitId]?.lastRoundDir;
  if (!rel) return null;
  const dir = path.join(ctx.root, rel);
  // a round dir a person has cleared out is a brief without a previous round, not a failed run
  const readOrNull = async <T>(schema: ZodType<T>, file: string): Promise<T | null> => {
    try {
      return await readJson(schema, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
  const record = await readOrNull(RoundRecordSchema, path.join(dir, ROUND_FILES.round));
  if (!record) return null;
  const verifyFile = record.verify ? path.join(ctx.root, record.verify.file) : null;
  const verify = verifyFile ? await readOrNull(VerifyResultSchema, verifyFile) : null;
  const reviewerOutput = record.reviewer?.output;
  const reasons = reviewerOutput && 'verdict' in reviewerOutput ? reviewerOutput.reasons : [];
  return { verify, reviewerReasons: reasons, reason: record.reason };
}

/**
 * a worker call retried across rate limits, each wait logged on the record and in the manifest.
 * the caller sees the last result: a call still rate limited at the cap comes back as one, and
 * its outcome fails the round like any other.
 */
async function withBackoff<T>(
  ctx: RoundContext,
  record: RoundRecord,
  unitId: string,
  call: () => Promise<WorkerResult<T>>,
): Promise<WorkerResult<T>> {
  for (let attempt = 0; ; attempt++) {
    const r = await call();
    if (r.outcome !== 'rate_limited' || ctx.signal.aborted) return r;
    if (attempt >= MAX_RATE_LIMIT_RETRIES) {
      ctx.log(
        `${unitId}: still rate limited after ${attempt} waits; failing round ${record.round}`,
      );
      return r;
    }
    const ms = ctx.backoffMs[Math.min(attempt, ctx.backoffMs.length - 1)] ?? 60_000;
    ctx.log(
      `${unitId}: rate limited (${r.reason}); waiting ${ms} ms, then retrying round ${record.round}`,
    );
    record.waits.push({ at: now(), ms, why: r.reason ?? 'rate_limited' });
    await ctx.store.transition(unitId, { type: 'rate_limited' });
    await sleep(ms, ctx.signal);
    // the wait ended early because the run was aborted: hand back the rate-limited result
    // rather than spawning a worker the abort is about to kill
    if (ctx.signal.aborted) return r;
  }
}

/** one compile check, appended to checks.txt; `how` is what the record cannot hold: exit, signal or timeout */
async function runCheck(
  ctx: RoundContext,
  project: string,
  dir: string,
  check: Check,
): Promise<{ entry: RoundRecord['checks'][number]; how: string }> {
  // the same group handling the worker gets: `npx` has a child of its own that holds the pipes,
  // so a check killed at the timeout would otherwise leave the round waiting on it
  const r = await runInGroup({
    command: check.command,
    args: check.args,
    timeoutMs: ORCHESTRATE.checkTimeoutMs,
    signal: ctx.signal,
    options: { cwd: project, env: ctx.env, extendEnv: true },
  });
  // a check killed at the timeout has no exit code to report: say so, rather than calling the
  // kill signal we sent the check's own answer
  const how = r.timedOut
    ? `timed out after ${ORCHESTRATE.checkTimeoutMs} ms`
    : r.cancelled
      ? 'interrupted'
      : `exit ${r.exitCode ?? (r.isTerminated ? 'signal' : 'none')}`;
  await fs.appendFile(
    path.join(dir, ROUND_FILES.checks),
    `$ ${check.command} ${check.args.join(' ')}\n${r.all}\n${how}\n\n`,
  );
  return {
    entry: { name: check.name, exitCode: r.exitCode, ok: !r.timedOut && r.exitCode === 0 },
    how,
  };
}

/** what a blocked unit points a reader at: the brief, verify.json and its images, the reviewer's record */
async function artefactsOf(ctx: RoundContext, dir: string, record: RoundRecord): Promise<string[]> {
  const out = [path.join(dir, ROUND_FILES.brief)];
  if (record.verify) {
    const file = path.join(ctx.root, record.verify.file);
    out.push(file);
    try {
      out.push(...(await readJson(VerifyResultSchema, file)).artefacts);
    } catch {
      /* the file is named; its images are a bonus */
    }
  }
  if (record.reviewer) out.push(path.join(dir, ROUND_FILES.reviewer));
  return out;
}

/**
 * the same crash twice running, with no tool call in either: the runner's own defect rather than
 * a build the next round could fix. a flag the binary refuses, a binary that is not there, an
 * environment it will not start in: each kills every call the same way in about a second, and
 * measured on the first real run, every unit spent its whole budget of rounds on one refused
 * `--json-schema`. only a crash counts, and only with the same reason: a malformed output or a
 * timeout is the model's doing and retries as before.
 */
function runnerDefect<T>(
  builder: WorkerResult<T>,
  reason: string,
  previousReason: string | null,
): boolean {
  if (builder.outcome !== 'crashed' || previousReason !== reason) return false;
  // no result object at all, or one that never reached a second turn: nothing was built
  return builder.result === null || (builder.record.numTurns ?? 0) <= 1;
}

/**
 * one round for one captured unit (spec section 5): the brief, the builder with its hooks,
 * the compile checks, the orchestrator's own verify from its own browser, the reviewer. the
 * builder's output is logged and never read as success. a failed step sends the unit back to
 * captured, or blocks it with the artefacts and a question once the budget is spent; a rate
 * limit waits and retries the same worker. an abort mid-round returns `interrupted` and
 * leaves the status for build.ts to restore.
 */
export async function runRound(ctx: RoundContext, unitId: string): Promise<RoundRecord> {
  // the edit hook resolves a tool's path against the worker's own cwd, which the os reports
  // resolved (macos /var is /private/var), and compares it textually against the allowed list.
  // one realpath here is what keeps the two spellings the same; two would deny every edit. it
  // is read before the round is spent, so a project that is not there costs the unit nothing.
  const project = await fs.realpath(ctx.project);
  const unit = await ctx.store.transition(unitId, { type: 'build_started' });
  const round = unit.rounds;
  const dir = ctx.run.roundDir(unitId, round);
  // an interrupted round's leftovers are not this round's
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const record: RoundRecord = {
    unitId,
    round,
    dir: path.relative(ctx.root, dir),
    startedAt: now(),
    endedAt: null,
    builder: null,
    checks: [],
    verify: null,
    reviewer: null,
    waits: [],
    result: 'retry',
    reason: null,
  };
  const finish = async (result: RoundRecord['result'], reason: string | null) => {
    record.result = result;
    record.reason = reason;
    record.endedAt = now();
    RoundRecordSchema.parse(record);
    await writeJson(path.join(dir, ROUND_FILES.round), record);
    await ctx.onRound(record);
    return record;
  };
  // `defect`, when given, is the question a runner defect blocks with: the budget is not spent,
  // but nothing in it would be spent on anything else, so the unit blocks now and says why
  const fail = async (reason: string, event: Event, defect: string | null = null) => {
    ctx.log(`${unitId}: round ${round} failed: ${reason}`);
    await ctx.store.transition(unitId, event);
    await ctx.store.update((m) => {
      m.units[unitId]!.lastRoundDir = record.dir;
    });
    const spent = ctx.store.get().units[unitId]!.rounds;
    if (!defect && spent < ctx.rounds) return finish('retry', reason);
    const artefacts = await artefactsOf(ctx, dir, record);
    await ctx.store.transition(unitId, {
      type: 'blocked',
      code: ERROR_CODES.roundsExhausted,
      message: defect ?? `${spent} round${spent === 1 ? '' : 's'} without a pass: ${reason}`,
      artefacts,
    });
    return finish('blocked', reason);
  };

  const threshold = ctx.threshold ?? unit.thresholdOverride ?? DEFAULT_PIXEL_GATE;
  const shotsDir = path.join(dir, ROUND_FILES.shots);
  const briefInput: BriefInput = {
    root: ctx.root,
    manifest: ctx.store.get(),
    unitId,
    round,
    rounds: ctx.rounds,
    project,
    target: ctx.target,
    threshold,
    shotsDir,
    previous: await previousRound(ctx, unitId),
  };
  const brief = await builderBrief(briefInput);
  const allowedFile = path.join(dir, ROUND_FILES.allowed);
  await writeJson(allowedFile, allowedFilesFor(ctx.store.get(), unitId, project));
  const settingsFile = path.join(dir, ROUND_FILES.settings);
  await writeHookSettings(settingsFile, {
    site: ctx.site,
    pack: ctx.root,
    unitId,
    target: ctx.target,
    allowedFile,
    stopStateFile: path.join(dir, ROUND_FILES.stopState),
    verifyOutDir: path.join(dir, ROUND_FILES.verifyHook),
    maxBlocks: ctx.stopHookBlocks,
    gate: ctx.threshold,
  });

  const builder = await withBackoff(ctx, record, unitId, () =>
    runWorker({
      role: 'builder',
      claude: ctx.claude,
      cwd: project,
      brief,
      maxTurns: ctx.turns.builder,
      timeoutMs: ctx.timeouts.builderMs,
      tools: BUILDER_TOOLS,
      // the verify rules are the round's own: this pack, this unit, in every spelling a model
      // types them. allowedTools is per call, so no worker is ever handed a rule that reaches
      // another unit's pack or another unit
      allowedTools: [
        ...BUILDER_ALLOWED,
        ...verifyRuleFor(ctx.root, unitId),
        ...shotRuleFor(ctx.root, unitId),
      ],
      settingsFile,
      addDirs: [ctx.root],
      schema: WorkerOutputSchema,
      outDir: dir,
      files: {
        brief: ROUND_FILES.brief,
        stdout: ROUND_FILES.builderStdout,
        stderr: ROUND_FILES.builderStderr,
        record: ROUND_FILES.builder,
      },
      env: ctx.env,
      model: ctx.models.builder,
      signal: ctx.signal,
    }),
  );
  record.builder = builder.record;
  if (ctx.signal.aborted) return finish('interrupted', 'interrupted');
  if (builder.outcome !== 'done') {
    const reason = `builder ${builder.outcome}${builder.reason ? `: ${builder.reason}` : ''}`;
    const defect = runnerDefect(builder, reason, briefInput.previous?.reason ?? null)
      ? `the builder crashed the same way twice without reaching a tool call, so the rounds left would go the same way: ${reason}`
      : null;
    return fail(reason, { type: 'build_failed', reason: builder.outcome }, defect);
  }
  // what the builder says it did is a log line and nothing more: the gates below decide
  ctx.log(
    `${unitId}: builder done in ${builder.record.numTurns ?? '?'} turns: ${builder.output!.summary}${
      builder.output!.notes ? ` (notes: ${builder.output!.notes})` : ''
    }`,
  );

  for (const check of ctx.checks) {
    const { entry, how } = await runCheck(ctx, project, dir, check);
    record.checks.push(entry);
    if (!entry.ok) {
      // an abort kills the checks with everything else; a check that died with the run is not
      // this round's verdict, so the interrupt is read before the failure
      if (ctx.signal.aborted) return finish('interrupted', 'interrupted');
      return fail(`${check.name} failed (${how}, see ${ROUND_FILES.checks})`, {
        type: 'build_failed',
        reason: `${check.name} failed`,
      });
    }
  }
  if (ctx.signal.aborted) return finish('interrupted', 'interrupted');

  await ctx.store.transition(unitId, { type: 'verify_started' });
  const verifyDir = path.join(dir, ROUND_FILES.verify);
  const verify = await verifyUnit({
    root: ctx.root,
    unitId,
    target: ctx.target,
    session: ctx.session,
    outDir: verifyDir,
    gate: ctx.threshold,
  });
  const score = worstScore(verify);
  record.verify = {
    verdict: verify.verdict,
    score,
    file: path.relative(ctx.root, path.join(verifyDir, VERIFY_FILE)),
  };
  // verify takes a browser and a minute; an abort landing inside it tears the dev server down
  // under it, and the fail that would follow is the interrupt's, not the rebuild's
  if (ctx.signal.aborted) return finish('interrupted', 'interrupted');
  if (verify.verdict === 'fail') {
    return fail(`verify failed: ${summaryLine(verify)}`, { type: 'verify_failed', score });
  }
  await ctx.store.transition(unitId, { type: 'verify_passed', score });

  const reviewer = await withBackoff(ctx, record, unitId, async () =>
    runWorker({
      role: 'reviewer',
      claude: ctx.claude,
      cwd: project,
      brief: await reviewerBrief({ ...briefInput, verify, builder: builder.output }),
      maxTurns: ctx.turns.reviewer,
      timeoutMs: ctx.timeouts.reviewerMs,
      tools: REVIEWER_TOOLS,
      allowedTools: REVIEWER_ALLOWED,
      settingsFile: null,
      addDirs: [ctx.root],
      schema: ReviewerOutputSchema,
      outDir: dir,
      files: {
        brief: ROUND_FILES.reviewBrief,
        stdout: ROUND_FILES.reviewerStdout,
        stderr: ROUND_FILES.reviewerStderr,
        record: ROUND_FILES.reviewer,
      },
      env: ctx.env,
      model: ctx.models.reviewer,
      signal: ctx.signal,
    }),
  );
  record.reviewer = reviewer.record;
  if (ctx.signal.aborted) return finish('interrupted', 'interrupted');
  if (reviewer.outcome !== 'done') {
    return fail(`reviewer ${reviewer.outcome}${reviewer.reason ? `: ${reviewer.reason}` : ''}`, {
      type: 'review_failed',
      reason: reviewer.outcome,
    });
  }
  if (reviewer.output!.verdict === 'reject') {
    return fail(`reviewer rejected: ${reviewer.output!.reasons.join('; ') || 'no reason given'}`, {
      type: 'review_rejected',
    });
  }
  await ctx.store.transition(unitId, { type: 'review_passed' });
  ctx.log(`${unitId}: passed in round ${round}`);
  return finish('passed', null);
}

/**
 * how long a unit waits before retrying a round whose builder crashed. a crash is the binary
 * or the api, not the build: two transient errors seconds apart would otherwise spend two of
 * the six rounds in a few seconds and block the unit with nothing tried. `runnerDefect` blocks
 * on two identical crashes with no turn spent, and this wait is what makes that test mean
 * something: a defect crashes the same way after it too, a transient error does not.
 * SITE_CRASH_RETRY_MS shortens it for the tests; it is read once, on the first crash.
 */
const DEFAULT_CRASH_RETRY_MS = 30_000;
let crashRetryMs: number | null = null;
function crashRetry(): number {
  if (crashRetryMs === null) {
    const raw = Number(process.env['SITE_CRASH_RETRY_MS']);
    crashRetryMs = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CRASH_RETRY_MS;
  }
  return crashRetryMs;
}

/** rounds until the unit passes, blocks, or the run is interrupted */
export async function workUnit(
  ctx: RoundContext,
  unitId: string,
): Promise<'passed' | 'blocked' | 'interrupted'> {
  for (;;) {
    const r = await runRound(ctx, unitId);
    if (r.result !== 'retry') return r.result;
    if (r.builder?.outcome !== 'crashed') continue;
    const ms = crashRetry();
    if (!ms) continue;
    ctx.log(`${unitId}: the builder crashed; waiting ${ms} ms before the next round`);
    await sleep(ms, ctx.signal);
    // the wait ended early because the run was aborted: the round that follows would be
    // interrupted anyway, and build.ts restores the status
    if (ctx.signal.aborted) return 'interrupted';
  }
}
