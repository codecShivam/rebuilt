import fs from 'node:fs/promises';
import path from 'node:path';
import { execa, type Options } from 'execa';
import { z, type ZodType } from 'zod';
import { writeJson } from '../pack/io';
import {
  ClaudeResultSchema,
  WorkerRunSchema,
  type ClaudeResult,
  type WorkerOutcome,
  type WorkerRole,
  type WorkerRun,
} from '../pack/schemas';
import { RATE_LIMIT_PATTERN } from './defaults';

export interface WorkerCall<T> {
  role: WorkerRole;
  /** the binary: `claude`, or a path (the fake under test) */
  claude: string;
  /** the rebuilt project: the process's cwd */
  cwd: string;
  /** the brief, piped on stdin; nothing goes on argv */
  brief: string;
  /** `--max-turns` */
  maxTurns: number;
  /** wall clock, ms; the process is killed past it */
  timeoutMs: number;
  /** `--tools`: the built-in set the worker may use */
  tools: string[];
  /** `--allowedTools`: what runs without a prompt (under dontAsk, what runs at all) */
  allowedTools: string[];
  /** `--settings <file>` carrying the hooks; null for a reviewer */
  settingsFile: string | null;
  /** `--add-dir`: the pack, so the worker may read what the brief points at */
  addDirs: string[];
  /** the output shape: `--json-schema` is derived from it and the result is parsed by it */
  schema: ZodType<T>;
  /** where the brief, stdout, stderr and the record are written */
  outDir: string;
  files: { brief: string; stdout: string; stderr: string; record: string };
  env?: NodeJS.ProcessEnv;
  model?: string;
  /** the orchestrator's abort on SIGINT or SIGTERM */
  signal?: AbortSignal;
}

export interface RawRun {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  spawnError: string | null;
}

export interface Classified<T> {
  outcome: WorkerOutcome;
  output: T | null;
  /** why it was classified so; null when done */
  reason: string | null;
  result: ClaudeResult | null;
}

export interface WorkerResult<T> extends Classified<T> {
  record: WorkerRun;
}

/**
 * what a claude code session sets in every child it spawns. with CLAUDECODE set the binary
 * refuses to run nested (measured on 2.1.278), so a `site build` started from inside a session
 * would crash every round; the rest name a session this worker is not part of. all of them are
 * stripped, so a build works from a terminal and from inside a session alike.
 */
// claude: CLAUDE_EFFORT is inherited on purpose today, so a worker thinks as hard as the session
// that started it; the first real run decides whether to strip it too
export const CLAUDE_SESSION_ENV = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID)$/;

export function stripClaudeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CLAUDE_SESSION_ENV.test(name)));
}

/**
 * the worker's whole environment: the call's variables over this process's, then the session
 * variables taken out. built here rather than left to execa's extendEnv, because a variable
 * deleted from the overrides would come straight back from process.env.
 */
export function workerEnv(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return stripClaudeEnv({ ...process.env, ...overrides });
}

/** SIGTERM, then SIGKILL after this, to the whole group; also the step of the hard bound below */
export const FORCE_KILL_AFTER_MS = 5_000;

/** what a child's streams may hold before the rest is dropped; execa's old maxBuffer */
const MAX_OUTPUT = 64 * 1024 * 1024;

/**
 * signal a process group, falling back to the leader alone. every child this module starts is
 * spawned detached and so leads a group of its own: `claude`'s Bash grandchildren (a
 * `site verify` with its chromium, an `npx next lint`), the keeper's chromium, `npx`'s own
 * child. signalling the leader alone leaves them running and holding the pipes.
 */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* not a group of its own, or gone already */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* gone between the probe and the kill */
  }
}

/** a stream read as it arrives, capped; a destroyed stream keeps whatever it had said by then */
function collect(stream: NodeJS.ReadableStream | null | undefined, into: Buffer[][]): void {
  if (!stream) return;
  let size = 0;
  stream.on('data', (chunk: Buffer) => {
    if (size >= MAX_OUTPUT) return;
    size += chunk.length;
    for (const buffers of into) buffers.push(chunk);
  });
  // a destroyed stream errors; what it had already said still counts
  stream.on('error', () => {});
}

export interface GroupRun {
  exitCode: number | null;
  /** killed by us at `timeoutMs` */
  timedOut: boolean;
  /** killed by us because the caller's signal aborted */
  cancelled: boolean;
  /** terminated by a signal, whoever sent it */
  isTerminated: boolean;
  /** the process never started (ENOENT and friends), in execa's words; null when it did */
  spawnError: string | null;
  /** the streams did not close even after the group was killed, so what was captured is all there is */
  hardStopped: boolean;
  stdout: string;
  stderr: string;
  /** stdout and stderr as they arrived, for a caller that logs one stream */
  all: string;
}

/**
 * one child in a process group of its own, with our own timeout and abort handling.
 *
 * execa's `timeout` and `cancelSignal` signal the direct child, and `forceKillAfterDelay`
 * reaches the same one process; the promise then waits for the pipes, which the child's own
 * grandchildren inherit and hold. measured on the second real run: a builder killed at its
 * 20 minute wall clock took 2 h 29 m 36 s to settle, with an empty stdout, because a
 * `site verify` it had started still held the pipe. so: the child leads a group, the group
 * gets SIGTERM and then SIGKILL, the output is collected here rather than by execa, and past
 * `timeoutMs + 2 * FORCE_KILL_AFTER_MS` the streams are destroyed and what was captured is
 * what the caller gets.
 */
export async function runInGroup(opts: {
  command: string;
  args: string[];
  /** wall clock, ms; the group is killed past it */
  timeoutMs: number;
  signal?: AbortSignal;
  options: Options;
}): Promise<GroupRun> {
  const child = execa(opts.command, opts.args, {
    ...opts.options,
    detached: true,
    reject: false,
    // the output is this function's to collect: with execa buffering it, a stream that never
    // closes is a promise that never settles, and there is no way to read what did arrive
    buffer: false,
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  const all: Buffer[] = [];
  collect(child.stdout, [out, all]);
  collect(child.stderr, [err, all]);

  const pid = child.pid ?? null;
  let timedOut = false;
  let cancelled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const endGroup = () => {
    if (pid === null) return;
    killGroup(pid, 'SIGTERM');
    timers.push(setTimeout(() => killGroup(pid, 'SIGKILL'), FORCE_KILL_AFTER_MS));
  };
  timers.push(
    setTimeout(() => {
      timedOut = true;
      endGroup();
    }, opts.timeoutMs),
  );
  const onAbort = () => {
    cancelled = true;
    endGroup();
  };
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener('abort', onAbort, { once: true });

  const finished = child.then(
    (r) => r,
    () => null,
  );
  const hard = new Promise<'hard'>((resolve) => {
    timers.push(setTimeout(() => resolve('hard'), opts.timeoutMs + 2 * FORCE_KILL_AFTER_MS));
  });
  const raced = await Promise.race([finished, hard]);
  const hardStopped = raced === 'hard';
  if (hardStopped) {
    // nothing in the group would let the pipes go: take what was captured and stop waiting
    if (pid !== null) killGroup(pid, 'SIGKILL');
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
  for (const t of timers) clearTimeout(t);
  opts.signal?.removeEventListener('abort', onAbort);
  const r = hardStopped ? null : raced;
  return {
    exitCode: r?.exitCode ?? null,
    timedOut,
    cancelled,
    isTerminated: r?.isTerminated ?? hardStopped,
    // no exit code, no signal and no kill of ours means the process never started
    spawnError:
      r && r.exitCode === undefined && !r.isTerminated && !timedOut && !cancelled
        ? r.shortMessage || 'could not start'
        : null,
    hardStopped,
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
    all: Buffer.concat(all).toString('utf8'),
  };
}

/** the exact argv, from the flags verified on 2026-09-18 (see the plan's surface table). */
export function argsFor<T>(
  call: Pick<
    WorkerCall<T>,
    'maxTurns' | 'tools' | 'allowedTools' | 'settingsFile' | 'addDirs' | 'schema' | 'model'
  >,
): string[] {
  // the shape the binary takes: draft-7, and with no `$schema` key at all. zod 4 stamps the
  // 2020-12 uri by default, and 2.1.278 has no meta-schema for it: every call of every role died
  // at argument parsing with `--json-schema is not a valid JSON Schema: no schema with key or ref
  // "https://json-schema.org/draft/2020-12/schema"` on the first real run. dropping the key and
  // asking for the older target are each enough on their own (probed); both are done here,
  // because the key is the part the validator chokes on and the target is what keeps the body
  // one 2.1.278 understands
  const { $schema: _drop, ...schema } = z.toJSONSchema(call.schema, {
    target: 'draft-7',
  }) as Record<string, unknown>;
  const args = [
    '-p',
    '--output-format',
    'json',
    '--max-turns',
    String(call.maxTurns),
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--no-session-persistence',
    // `project`, never the default sources: on this machine the user's own ~/.claude/settings.json
    // allows Bash(*), Write(*) and Edit(*) and carries hooks of its own, and a worker run with
    // it inherits all of that (measured 2026-09-19): every tool call auto-approved, the allowlist
    // decoration. the scaffold has no .claude/, so `project` loads nothing; --settings is a layer
    // of its own that this flag does not filter, and its hooks fire under it (measured)
    '--setting-sources',
    'project',
    // both flags are variadic; one comma-joined value is the documented form and cannot swallow
    // the arguments after it
    '--tools',
    call.tools.join(','),
    '--allowedTools',
    call.allowedTools.join(','),
    '--json-schema',
    JSON.stringify(schema),
  ];
  if (call.settingsFile) args.push('--settings', call.settingsFile);
  for (const dir of call.addDirs) args.push('--add-dir', dir);
  if (call.model) args.push('--model', call.model);
  return args;
}

function tail(s: string, n = 400): string {
  return s.trim().slice(-n);
}

/** the one result object on stdout: the whole of it, or the last line that parses as one. */
export function findResult(stdout: string): ClaudeResult | null {
  const trimmed = stdout.trim();
  const candidates = [
    trimmed,
    ...trimmed
      .split('\n')
      .reverse()
      .map((l) => l.trim()),
  ];
  for (const c of candidates) {
    if (!c.startsWith('{')) continue;
    let value: unknown;
    try {
      value = JSON.parse(c);
    } catch {
      continue;
    }
    const parsed = ClaudeResultSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** a json object inside free text: a ```json fence, else the outermost braces; undefined when none parses. */
export function jsonIn(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!body.trim().startsWith('{')) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * the typed outcome of one call. only `done` carries an output, and even then the output is
 * what the worker said, never what happened: the round runs verify itself. the order matters:
 * a max-turns result and a 429 both come back with is_error, and each has its own outcome.
 */
export function classify<T>(raw: RawRun, schema: ZodType<T>): Classified<T> {
  const none = (
    outcome: WorkerOutcome,
    reason: string,
    result: ClaudeResult | null = null,
  ): Classified<T> => ({ outcome, output: null, reason, result });
  if (raw.spawnError) return none('crashed', raw.spawnError);
  if (raw.timedOut) return none('timeout', 'wall clock exceeded');
  const text = `${raw.stdout}\n${raw.stderr}`;
  const result = findResult(raw.stdout);
  if (!result) {
    if (RATE_LIMIT_PATTERN.test(text)) return none('rate_limited', tail(text));
    if (raw.exitCode !== 0) {
      return none(
        'crashed',
        `exit ${raw.exitCode ?? 'signal'}: ${tail(raw.stderr) || tail(raw.stdout)}`,
      );
    }
    return none('malformed_output', 'no result object on stdout');
  }
  if (result.subtype === 'error_max_turns' || result.terminal_reason === 'max_turns') {
    return none('turns_exhausted', `${result.num_turns ?? '?'} turns`, result);
  }
  const status = result.api_error_status;
  if (status === 429 || status === 529) return none('rate_limited', `api ${status}`, result);
  const failure = [result.result ?? '', ...(result.errors ?? [])].join('\n');
  // the model kept answering with something the json schema refused: that is a malformed
  // output, and the round retries it like any other, rather than a crash of the binary
  if (result.subtype === 'error_max_structured_output_retries') {
    return none('malformed_output', `${result.subtype}: ${tail(failure) || 'no output'}`, result);
  }
  if (result.is_error || result.subtype !== 'success') {
    if (RATE_LIMIT_PATTERN.test(`${failure}\n${raw.stderr}`)) {
      return none('rate_limited', tail(failure) || tail(raw.stderr), result);
    }
    return none('crashed', `${result.subtype}: ${tail(failure) || tail(raw.stderr)}`, result);
  }
  const candidate =
    result.structured_output !== undefined ? result.structured_output : jsonIn(result.result ?? '');
  if (candidate === undefined)
    return none('malformed_output', 'no json object in the result', result);
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.join('.') || '(root)' : '?';
    return none(
      'malformed_output',
      `output failed its schema at ${where}: ${issue?.message ?? 'invalid'}`,
      result,
    );
  }
  return { outcome: 'done', output: parsed.data, reason: null, result };
}

/**
 * one `claude -p` call: the brief on stdin, the flags above, the cwd the project. everything
 * is logged under outDir before the outcome is returned: the brief, stdout, stderr and the
 * record with the timing. the runner never interprets the worker's opinion of its work.
 */
export async function runWorker<T>(call: WorkerCall<T>): Promise<WorkerResult<T>> {
  await fs.mkdir(call.outDir, { recursive: true });
  await fs.writeFile(path.join(call.outDir, call.files.brief), call.brief);
  const startedAt = new Date();
  const r = await runInGroup({
    command: call.claude,
    args: argsFor(call),
    timeoutMs: call.timeoutMs,
    signal: call.signal,
    options: {
      cwd: call.cwd,
      input: call.brief,
      env: workerEnv(call.env),
      extendEnv: false,
    },
  });
  const durationMs = Date.now() - startedAt.getTime();
  // the logs are the raw streams, whatever arrived before the group was killed
  const { stdout, stderr } = r;
  await fs.writeFile(path.join(call.outDir, call.files.stdout), stdout);
  await fs.writeFile(path.join(call.outDir, call.files.stderr), stderr);
  // an abort is the run's own doing, not this call's failure, and it is what the round reads
  const spawnError = r.cancelled ? 'cancelled' : r.spawnError;
  const classified = classify(
    { exitCode: r.exitCode, timedOut: r.timedOut, stdout, stderr, spawnError },
    call.schema,
  );
  // the hard bound fired: the group survived its kill and the streams were cut, so the record
  // says so instead of reading as a plain timeout
  const reason = r.hardStopped
    ? `${classified.reason ?? 'timed out'}; the process group survived SIGKILL and its streams were cut at the hard bound`
    : classified.reason;
  const record: WorkerRun = {
    role: call.role,
    outcome: classified.outcome,
    reason,
    exitCode: r.exitCode,
    numTurns: classified.result?.num_turns ?? null,
    sessionId: classified.result?.session_id ?? null,
    costUsd: classified.result?.total_cost_usd ?? null,
    stopReason: classified.result?.stop_reason ?? null,
    startedAt: startedAt.toISOString(),
    durationMs,
    output: classified.outcome === 'done' ? (classified.output as WorkerRun['output']) : null,
    files: { brief: call.files.brief, stdout: call.files.stdout, stderr: call.files.stderr },
  };
  // the record is this call's only account of itself; a record that cannot be validated or
  // written is this call's failure, not the run's, so it degrades rather than throwing
  try {
    WorkerRunSchema.parse(record);
    await writeJson(path.join(call.outDir, call.files.record), record);
  } catch (err) {
    const reason = `could not write the record: ${err instanceof Error ? err.message : String(err)}`;
    return {
      outcome: 'crashed',
      output: null,
      reason,
      result: classified.result,
      record: { ...record, outcome: 'crashed', reason, output: null },
    };
  }
  return { ...classified, record };
}
