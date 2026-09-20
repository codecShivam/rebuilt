import fs from 'node:fs/promises';
import path from 'node:path';
import { openSession, type Session } from '../capture/session';
import { ERROR_CODES } from '../pack/defaults';
import { writeJsonAtomic } from '../pack/io';
import { DEV_SERVER_FILES, PackPaths, RunPaths } from '../pack/paths';
import { RunLogSchema, type Manifest, type RunLog } from '../pack/schemas';
import { budgetProblem, DEFAULT_CHECKS, ORCHESTRATE, type Check } from './defaults';
import { siteBin, siteEnv } from './hooks';
import { acquireLock, processAlive } from './lock';
import { workUnit, type RoundContext } from './round';
import { startDevServer, type DevServer } from './scaffold/dev-server';
import { dependentsOf, nextUnits, openQuestions, restore, scopesOf, transition } from './state';
import { ManifestStore } from './store';

export class QuestionsOpenError extends Error {
  constructor(readonly questions: Manifest['questions']) {
    super(
      `${questions.length} question${questions.length === 1 ? '' : 's'} unanswered; answer in manifest.json (questions[].answer), set the flow input named, or rerun with --reopen <unit>:\n` +
        questions.map((q) => `  [${q.id}] ${q.text}`).join('\n'),
    );
    this.name = 'QuestionsOpenError';
  }
}

/** `2026-09-18T10-00-00`: sortable, and a dir name on every filesystem */
export function runName(date: Date = new Date()): string {
  return date
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/:/g, '-');
}

/**
 * a run dir this run owns, and the name that goes with it. runName has second resolution, so
 * two runs started inside one second would otherwise share a dir: the second would overwrite
 * the first's run.json and work into its round dirs. mkdir without `recursive` is the exclusive
 * create, so the dir is claimed by the same call that finds it free.
 */
export async function freeRunName(root: string, base: string): Promise<string> {
  await fs.mkdir(new PackPaths(root).runsDir, { recursive: true });
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    try {
      await fs.mkdir(new RunPaths(root, name).dir);
      return name;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

export interface BuildOptions {
  root: string;
  project: string;
  /** a running rebuild; absent starts `npm run dev` in the project */
  target?: string;
  parallel?: number;
  rounds?: number;
  threshold?: number;
  claude?: string;
  site?: string;
  checks?: Check[];
  turns?: { builder: number; reviewer: number };
  timeouts?: { builderMs: number; reviewerMs: number };
  backoffMs?: number[];
  stopHookBlocks?: number;
  /** the model alias per role; absent means the binary's own default */
  models?: { builder?: string; reviewer?: string };
  env?: NodeJS.ProcessEnv;
  run?: string;
  /** blocked units to put back in the queue first */
  reopen?: string[];
  signal?: AbortSignal;
  log?: (line: string) => void;
  devServer?: { port?: number };
}

export interface BuildResult {
  run: string;
  passed: string[];
  blocked: string[];
  interrupted: string[];
  restored: string[];
  log: RunLog;
}

const now = () => new Date().toISOString();

/**
 * signal a process group and wait for its leader to go: SIGTERM, then SIGKILL once the grace
 * period is up, the same pair and the same budget `stop()` uses on a server this run started.
 * returns the signal that ended it, or null when it was already gone. a group that outlives
 * SIGKILL is not waited for beyond the grace: nothing else can be done about it, and the
 * caller says so in the log.
 */
async function stopGroup(pid: number): Promise<NodeJS.Signals | null> {
  const signal = (s: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, s);
      return true;
    } catch {
      // the group is gone already, or was never one; either way there is nothing to wait for
      return false;
    }
  };
  if (!processAlive(pid)) return null;
  const sent = signal('SIGTERM');
  const until = Date.now() + ORCHESTRATE.devServer.stopGraceMs;
  while (sent && Date.now() < until) {
    if (!processAlive(pid)) return 'SIGTERM';
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!processAlive(pid)) return sent ? 'SIGTERM' : null;
  signal('SIGKILL');
  return 'SIGKILL';
}

/**
 * a dev server a hard kill of a previous run left behind. it is spawned detached so its group
 * can be signalled, which also means it outlives the parent for ever and keeps holding its
 * port; a SIGKILL runs no cleanup in the parent, so the containment is here, in the next run
 * that takes the lock. every run dir but this one's is looked at: each holds the pid of the
 * server that run started. the pid file is unlinked after the signalling, never before, so a
 * run that dies in the middle of this leaves the next one the same work to do.
 */
export async function killStaleDevServers(
  root: string,
  thisRun: string,
  log: (line: string) => void,
): Promise<void> {
  const runsDir = new PackPaths(root).runsDir;
  let names: string[];
  try {
    names = await fs.readdir(runsDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === thisRun) continue;
    const file = path.join(runsDir, name, DEV_SERVER_FILES.pid);
    let pid: number;
    try {
      pid = Number((await fs.readFile(file, 'utf8')).trim());
    } catch {
      continue;
    }
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
      log(`run ${name} left a dev server running (pid ${pid}); stopping its process group`);
      const by = await stopGroup(pid);
      log(
        by === 'SIGKILL'
          ? `run ${name}'s dev server (pid ${pid}) did not stop within ${ORCHESTRATE.devServer.stopGraceMs} ms; killed its group with SIGKILL`
          : `run ${name}'s dev server (pid ${pid}) stopped on ${by ?? 'nothing: it was already gone'}`,
      );
    }
    await fs.rm(file, { force: true });
  }
}

/**
 * one step on the way out. a step that throws is logged and the next one still runs, so a
 * browser that died cannot leak the dev server or the lock, and whatever error the run is
 * already carrying stays the one that propagates.
 */
async function cleanUp(
  what: string,
  log: (line: string) => void,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    log(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * `site build` (spec section 5): refuse while a question is open, take the lock, restore what
 * a killed run left in flight, start and health-check the dev server unless a target is
 * given, then work the queue: at most `parallel` units at once on independent pages, each
 * through workUnit, every transition saved. a blocked unit blocks its dependents. SIGINT,
 * SIGTERM or the signal cancel the workers, put the in-flight units back, save and release.
 */
export async function build(opts: BuildOptions): Promise<BuildResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const parallel = opts.parallel ?? ORCHESTRATE.parallel;
  const rounds = opts.rounds ?? ORCHESTRATE.rounds;
  const claude = opts.claude ?? 'claude';
  const site = opts.site ?? siteBin();
  const turns = opts.turns ?? {
    builder: ORCHESTRATE.builderTurns,
    reviewer: ORCHESTRATE.reviewerTurns,
  };
  const stopHookBlocks = opts.stopHookBlocks ?? ORCHESTRATE.stopHookBlocks;
  // an argument error, refused before anything is taken or started: a cap of holds the binary
  // overrides, or a turn budget the holds alone would spend
  const problem = budgetProblem(turns, stopHookBlocks);
  if (problem) throw new Error(`turn budget: ${problem}`);
  const models = opts.models ?? {};
  // both hooks run with the project as their cwd, and the brief, --add-dir and the worker's
  // own `site verify` all carry these two paths: a relative spelling would resolve against the
  // project inside the worker and find nothing. everything below is built from these.
  const root = path.resolve(opts.root);
  const project = path.resolve(opts.project);
  const store = new ManifestStore(root);
  // a name the caller gave is taken as given; one this run made up gets a dir of its own first
  const run = opts.run ?? (await freeRunName(root, runName()));
  // the lock is taken before the manifest is read: everything this run reads, reopens and
  // writes back has to be the manifest nobody else is writing, or a reopen (and then the run's
  // own first save, made from a snapshot taken before the lock) lands on top of another
  // orchestrator's committed results
  const release = await acquireLock(root, run);
  const runPaths = new RunPaths(root, run);
  const controller = new AbortController();
  const abort = () => controller.abort();
  opts.signal?.addEventListener('abort', abort, { once: true });
  // a signal aborted before this call never fires its listener
  if (opts.signal?.aborted) controller.abort();
  const onSignal = () => {
    log('stopping: cancelling the workers; in-flight units go back to captured');
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let dev: DevServer | null = null;
  let session: Session | null = null;
  try {
    await store.load();
    if (opts.reopen?.length) {
      await store.update((m) => {
        for (const id of opts.reopen!) transition(m, id, { type: 'reopened' });
      });
    }
    const open = openQuestions(store.get());
    if (open.length) throw new QuestionsOpenError(open);
    const restored = await store.update((m) => restore(m));
    if (restored.length) log(`restored to captured after a killed run: ${restored.join(', ')}`);
    const runLog: RunLog = {
      run,
      root,
      project,
      target: opts.target ?? '',
      claude,
      options: { parallel, rounds, threshold: opts.threshold ?? null },
      models: { builder: models.builder ?? null, reviewer: models.reviewer ?? null },
      startedAt: now(),
      endedAt: null,
      restored,
      rounds: [],
    };
    // the log is rewritten whole and up to `parallel` workers finish a round at once, so the
    // writes queue on one chain, each through a temp file and a rename
    let saving: Promise<unknown> = Promise.resolve();
    const saveLog = () => {
      const write = saving.then(() => writeJsonAtomic(runPaths.log, RunLogSchema.parse(runLog)));
      saving = write.catch(() => undefined);
      return write;
    };
    await saveLog();
    let target = opts.target;
    if (!target) {
      await killStaleDevServers(root, run, log);
      dev = await startDevServer({
        project,
        log: runPaths.devServerLog,
        env: opts.env,
        port: opts.devServer?.port,
        signal: controller.signal,
      });
      target = dev.url;
      runLog.target = target;
      await saveLog();
      log(`dev server up at ${target}`);
    }
    session = await openSession({});
    const ctx: RoundContext = {
      root,
      project,
      target,
      run: runPaths,
      store,
      session,
      claude,
      site,
      rounds,
      threshold: opts.threshold,
      checks: opts.checks ?? DEFAULT_CHECKS,
      turns,
      timeouts: opts.timeouts ?? {
        builderMs: ORCHESTRATE.builderTimeoutMs,
        reviewerMs: ORCHESTRATE.reviewerTimeoutMs,
      },
      models,
      backoffMs: opts.backoffMs ?? ORCHESTRATE.rateLimitBackoffMs,
      stopHookBlocks,
      env: siteEnv(site, opts.env),
      signal: controller.signal,
      onRound: async (r) => {
        runLog.rounds.push(r);
        await saveLog();
      },
      log,
    };
    const passed: string[] = [];
    const blocked: string[] = [];
    const interrupted = new Set<string>();
    const inFlight = new Map<string, Promise<void>>();
    /** the first failure is the one that explains the run; the ones after it are its fallout */
    let failure: { error: unknown } | null = null;
    const stop = (err: unknown) => {
      failure ??= { error: err };
      controller.abort();
    };
    const cascade = (id: string) =>
      store.update((m) => {
        for (const dep of dependentsOf(m, id)) {
          const u = m.units[dep]!;
          if (u.status === 'blocked' || u.status === 'passed') continue;
          transition(m, dep, {
            type: 'blocked',
            code: ERROR_CODES.dependency,
            message: `depends on ${id}, which is blocked`,
          });
          blocked.push(dep);
          log(`${dep}: blocked, depends on ${id}`);
        }
      });
    // a unit blocked by an earlier run never blocks again in this one, so its dependents would
    // sit captured for ever and be scheduled never: the queue is squared with the blocks once,
    // here, before the first worker starts
    for (const [id, u] of Object.entries(store.get().units)) {
      if (u.status === 'blocked') await cascade(id);
    }
    const start = (id: string) => {
      log(`${id}: starting (round ${(store.get().units[id]?.rounds ?? 0) + 1} of ${rounds})`);
      const p = workUnit(ctx, id)
        .then(async (result) => {
          if (result === 'passed') passed.push(id);
          else if (result === 'interrupted') interrupted.add(id);
          else {
            blocked.push(id);
            await cascade(id);
          }
        })
        .catch((err: unknown) => {
          // a bug in the orchestrator stops the run; the unit is restored below like a kill
          stop(err);
        })
        .finally(() => {
          inFlight.delete(id);
        });
      inFlight.set(id, p);
    };
    /**
     * a started unit reaches `building` in the manifest a tick later, so nextUnits cannot see
     * it yet: this loop's own map of what is running is what keeps a second worker off a page
     * whose first worker has only just started, and the slots honest.
     */
    const startReady = () => {
      // a unit's scopes, all of them: its page, and `chrome` as well for a header, nav or
      // footer. they go in when it starts and come out with it, because this map is what is
      // running right now
      const busy = new Set([...inFlight.keys()].flatMap((id) => scopesOf(store.get(), id)));
      for (const id of nextUnits(store.get(), { parallel })) {
        if (inFlight.size >= parallel) return;
        if (inFlight.has(id)) continue;
        const scopes = scopesOf(store.get(), id);
        if (scopes.some((scope) => busy.has(scope))) continue;
        for (const scope of scopes) busy.add(scope);
        start(id);
      }
    };
    try {
      while (!controller.signal.aborted) {
        startReady();
        if (inFlight.size === 0) break;
        await Promise.race(inFlight.values());
      }
    } catch (err) {
      // a bug in the scheduling itself: the workers already running are cancelled and waited
      // for, rather than left running under a session this function is about to close
      stop(err);
    }
    await Promise.allSettled(inFlight.values());
    // the bookkeeping below must not lose the failure that got us here, so each step reports
    // its own only when there is nothing to report yet
    if (controller.signal.aborted) {
      try {
        for (const id of await store.update((m) => restore(m))) interrupted.add(id);
      } catch (err) {
        stop(err);
      }
    }
    runLog.endedAt = now();
    try {
      await saveLog();
    } catch (err) {
      stop(err);
    }
    if (failure) throw failure.error;
    log(
      `done: ${passed.length} passed, ${blocked.length} blocked, ${interrupted.size} interrupted`,
    );
    return { run, passed, blocked, interrupted: [...interrupted].sort(), restored, log: runLog };
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    opts.signal?.removeEventListener('abort', abort);
    if (session) {
      const opened = session;
      await cleanUp('closing the browser session', log, () => opened.close());
    }
    if (dev) {
      const started = dev;
      await cleanUp('stopping the dev server', log, () => started.stop());
    }
    await cleanUp('releasing the lock', log, release);
  }
}
