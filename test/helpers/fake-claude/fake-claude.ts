/**
 * a scripted stand-in for `claude -p`, driven by the scenario file named in SITE_FAKE_SCENARIO.
 * it honours the argv contract the runner uses (an unknown flag is refused the way the real
 * binary refuses one, before anything runs), reads the brief on stdin, picks the first
 * scenario entry whose `when` matches the brief's header and has uses left, applies its `do`
 * (files through the settings file's PreToolUse hooks, then the Stop hooks, then the result
 * json in the shape the real binary prints), and records every call in <scenario>.state.json.
 * it never reads the pack and never builds anything: the orchestrator's own gates are what the
 * tests prove. stdout is written with writeSync because a pipe on macos is asynchronous and an
 * exit right after write() would truncate it.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../../../src/pack/io';
import {
  HookSettingsSchema,
  ScenarioSchema,
  ScenarioStateSchema,
  type HookSettings,
  type ScenarioState,
} from '../../../src/pack/schemas';
import { parseBriefHeader } from '../../../src/orchestrate/brief-header';
import { STOP_HOOK_OVERRIDE } from '../../../src/orchestrate/defaults';

type HookGroup = NonNullable<HookSettings['hooks']['PreToolUse']>[number];

const FLAGS_WITH_VALUE = new Set([
  '--output-format',
  '--max-turns',
  '--permission-mode',
  '--permission-prompts',
  '--setting-sources',
  '--tools',
  '--allowedTools',
  '--json-schema',
  '--settings',
  '--add-dir',
  '--model',
  '--append-system-prompt',
  '--effort',
]);
const FLAGS_BARE = new Set(['-p', '--print', '--no-session-persistence', '--verbose']);

function fail(code: number, message: string): never {
  fs.writeSync(2, message + '\n');
  process.exit(code);
}

function parseArgv(argv: string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // the brief goes on stdin and nothing goes on argv: a positional is a contract violation,
    // not something to skip over
    if (!a.startsWith('-')) fail(2, `error: unexpected argument '${a}'`);
    if (FLAGS_BARE.has(a)) {
      flags.set(a, [...(flags.get(a) ?? []), '']);
      continue;
    }
    if (FLAGS_WITH_VALUE.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) fail(2, `error: option '${a}' argument missing`);
      flags.set(a, [...(flags.get(a) ?? []), v]);
      i++;
      continue;
    }
    fail(2, `error: unknown option '${a}'`);
  }
  return flags;
}

/** the hooks reference's matcher rule: empty or `*` is all, a plain list is exact names, anything else a regexp */
function matches(matcher: string | undefined, tool: string): boolean {
  if (!matcher || matcher === '*') return true;
  if (/^[A-Za-z0-9_\-|, ]+$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((s) => s.trim())
      .includes(tool);
  }
  return new RegExp(matcher).test(tool);
}

/** run every matching hook command with the input on stdin; the first deny or block wins, as in claude */
function runHooks(
  groups: HookGroup[] | undefined,
  tool: string | null,
  input: Record<string, unknown>,
  cwd: string,
): { blocked: boolean; reason: string | null } {
  for (const group of groups ?? []) {
    if (tool !== null && !matches(group.matcher, tool)) continue;
    for (const hook of group.hooks) {
      const r = spawnSync('sh', ['-c', hook.command], {
        cwd,
        input: JSON.stringify(input),
        encoding: 'utf8',
        timeout: (hook.timeout ?? 600) * 1000,
        env: process.env,
      });
      if (r.status === 2) return { blocked: true, reason: (r.stderr ?? '').trim() || 'exit 2' };
      const out = (r.stdout ?? '').trim();
      if (!out.startsWith('{') || !out.endsWith('}')) continue;
      let decision: Record<string, unknown>;
      try {
        decision = JSON.parse(out) as Record<string, unknown>;
      } catch {
        continue;
      }
      const spec = decision['hookSpecificOutput'] as Record<string, unknown> | undefined;
      if (spec?.['permissionDecision'] === 'deny') {
        return { blocked: true, reason: String(spec['permissionDecisionReason'] ?? 'denied') };
      }
      if (decision['decision'] === 'block') {
        return { blocked: true, reason: String(decision['reason'] ?? 'blocked') };
      }
    }
  }
  return { blocked: false, reason: null };
}

const argv = process.argv.slice(2);
const flags = parseArgv(argv);
// the binary refuses to run nested inside a claude code session (measured on 2.1.278); the
// runner strips the session's variables, and this is how the tests see that it did
if (process.env['CLAUDECODE']) {
  fail(1, 'fake claude: CLAUDECODE is set: a claude nested in a session refuses to run');
}
if (!flags.has('-p') && !flags.has('--print')) fail(2, 'fake claude: only -p is supported');
// the binary validates --json-schema before it runs anything: 2.1.278 resolves draft-07 and
// nothing newer, and a `$schema` it cannot resolve is refused with this message and exit 1
// (measured on the first real run, where zod's default 2020-12 uri killed every call). the
// wording for a value that is not a json object at all is this fake's own: no probe provoked it
const DRAFT_07 = 'http://json-schema.org/draft-07/schema#';
const schemaArg = flags.get('--json-schema')?.[0];
if (schemaArg !== undefined) {
  let value: unknown;
  try {
    value = JSON.parse(schemaArg);
  } catch {
    value = undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(1, 'Error: --json-schema is not a valid JSON Schema: not a json object');
  }
  const uri = (value as Record<string, unknown>)['$schema'];
  if (uri !== undefined && uri !== DRAFT_07) {
    fail(
      1,
      `Error: --json-schema is not a valid JSON Schema: no schema with key or ref "${String(uri)}"`,
    );
  }
}
const scenarioFile = process.env['SITE_FAKE_SCENARIO'];
if (!scenarioFile) fail(1, 'fake claude: SITE_FAKE_SCENARIO is not set');
const brief = fs.readFileSync(0, 'utf8');
const header = parseBriefHeader(brief);
const scenario = await readJson(ScenarioSchema, scenarioFile);
const stateFile = `${scenarioFile}.state.json`;
const cwd = process.cwd();
const startedAt = new Date().toISOString();

/** throws rather than exits: it runs under the lock, and process.exit would skip the release */
function readState(): ScenarioState {
  if (!fs.existsSync(stateFile)) return { uses: scenario.calls.map(() => 0), calls: [] };
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    throw new Error(`${stateFile} is not json`);
  }
  const parsed = ScenarioStateSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${stateFile} is not scenario state`);
  return parsed.data;
}

/** through a temp file and a rename, so a fake reading it never sees half a write */
function writeState(state: ScenarioState): void {
  const tmp = `${stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(ScenarioStateSchema.parse(state), null, 2) + '\n');
  fs.renameSync(tmp, stateFile);
}

/**
 * every read-modify-write of the state takes this lock: the orchestrator runs workers in
 * parallel, so two fakes share one scenario file, and without it both match the same entry
 * and the later writer drops the earlier one's call. mkdir is the atomic primitive every
 * filesystem gives us.
 */
function withStateLock<T>(fn: () => T): T {
  const lock = `${stateFile}.lock`;
  const until = Date.now() + 5_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (Date.now() > until) throw new Error(`${lock} was held for over 5s`);
      // a sync sleep: the whole point is that nothing else runs in this process meanwhile
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * a locked step that fails cleanly: nothing inside the callback may call process.exit, or the
 * release in the finally above never runs and the lock leaks to every later fake. they throw,
 * the lock comes off, and the failure is reported here.
 */
function locked<T>(what: string, fn: () => T): T {
  try {
    return withStateLock(fn);
  } catch (err) {
    fail(1, `fake claude: ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * claim an entry and record the call in one locked step, before any of the work: a call the
 * runner kills on its timeout still spends its `times` budget and still shows up in the state.
 * the slot is where this call landed, so the finish below can fill in what the work found.
 */
const claim = locked('claiming a scenario entry', () => {
  const state = readState();
  const index = scenario.calls.findIndex(
    (c, i) =>
      (state.uses[i] ?? 0) < (c.times ?? 1) &&
      (!c.when.role || c.when.role === header?.role) &&
      (!c.when.unit || c.when.unit === header?.unit) &&
      (!c.when.round || c.when.round === header?.round),
  );
  if (index >= 0) state.uses[index] = (state.uses[index] ?? 0) + 1;
  const slot = state.calls.length;
  state.calls.push({
    index: index < 0 ? null : index,
    role: header?.role ?? null,
    unit: header?.unit ?? null,
    round: header?.round ?? null,
    cwd,
    argv,
    // what the runner put in this call's environment for the tool's own commands to read; the
    // rest is the machine's
    env: Object.fromEntries(
      Object.entries(process.env)
        .filter(([name]) => name.startsWith('SITE_'))
        .map(([name, value]) => [name, value ?? '']),
    ),
    startedAt,
    endedAt: startedAt,
    denied: [],
    stopBlocks: 0,
  });
  writeState(state);
  return { index, slot };
});
function finish(extra: { denied: string[]; stopBlocks: number }): void {
  locked('recording the call', () => {
    const state = readState();
    const call = state.calls[claim.slot];
    if (call) {
      call.denied = extra.denied;
      call.stopBlocks = extra.stopBlocks;
      call.endedAt = new Date().toISOString();
    }
    writeState(state);
  });
}
if (claim.index < 0) {
  fail(
    1,
    `fake claude: no scenario entry for role=${header?.role} unit=${header?.unit} round=${header?.round}`,
  );
}
const act = scenario.calls[claim.index]!.do;
// a grandchild holding the runner's pipes, the way a `site verify` with its chromium or an
// `npx next lint` started by claude's Bash tool does: it inherits this process's stdout and
// stderr, so killing this process alone leaves the runner's await waiting on them (measured on
// the second real run: 2 h 29 m 36 s for a 20 minute timeout). it is in this process's group,
// which is what a group kill has to reach
if (act.holdPipes) spawn('sleep', ['60'], { stdio: 'inherit' }).unref();
if (act.sleepMs) await new Promise((r) => setTimeout(r, act.sleepMs));
const settingsFile = flags.get('--settings')?.[0];
const settings: HookSettings | null =
  act.honourHooks === false || !settingsFile
    ? null
    : await readJson(HookSettingsSchema, settingsFile);
const maxTurns = Number(flags.get('--max-turns')?.[0] ?? 100);
const sessionId = `fake-${process.pid}-${Date.now()}`;
const common = { session_id: sessionId, transcript_path: '', cwd, permission_mode: 'dontAsk' };
let turns = 1;
const denied: string[] = [];
for (const [rel, content] of Object.entries(act.writeFiles ?? {})) {
  const file = path.resolve(cwd, rel);
  const gate = runHooks(
    settings?.hooks.PreToolUse,
    'Write',
    {
      ...common,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: file, content },
    },
    cwd,
  );
  if (gate.blocked) {
    denied.push(file);
    continue;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
// the Stop hook may hold the worker; each hold costs a turn, and the turn budget ends it the
// way it ends the real binary: an error_max_turns result
let stopBlocks = 0;
let exhausted = false;
if (settings?.hooks.Stop) {
  for (;;) {
    const gate = runHooks(
      settings.hooks.Stop,
      null,
      {
        ...common,
        hook_event_name: 'Stop',
        stop_hook_active: stopBlocks > 0,
        last_assistant_message: '',
      },
      cwd,
    );
    if (!gate.blocked) break;
    stopBlocks += 1;
    turns += 1;
    if (turns > maxTurns) {
      exhausted = true;
      break;
    }
    // the binary honours nine consecutive holds (one with stop_hook_active false, eight with
    // it true) and then finishes normally, so a hook that never lets go is not a max-turns run
    if (stopBlocks >= STOP_HOOK_OVERRIDE) break;
  }
}
finish({ denied, stopBlocks });
const durationMs = Date.now() - Date.parse(startedAt);
if (act.stderr) fs.writeSync(2, act.stderr);
if (act.stdout !== undefined) {
  fs.writeSync(1, act.stdout);
  process.exitCode = act.exitCode ?? 0;
} else if (act.rateLimit) {
  const line = 'Claude AI usage limit reached|1758211200';
  fs.writeSync(2, line + '\n');
  fs.writeSync(
    1,
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 429,
      terminal_reason: 'api_error',
      stop_reason: 'end_turn',
      num_turns: turns,
      result: line,
      session_id: sessionId,
      total_cost_usd: 0,
      duration_ms: durationMs,
      permission_denials: [],
    }) + '\n',
  );
  process.exitCode = 1;
} else {
  const subtype = exhausted ? 'error_max_turns' : (act.subtype ?? 'success');
  const base = {
    type: 'result',
    subtype,
    is_error: subtype !== 'success',
    num_turns: turns,
    session_id: sessionId,
    total_cost_usd: 0,
    duration_ms: durationMs,
    terminal_reason: exhausted ? 'max_turns' : 'completed',
    stop_reason: 'end_turn',
    // the measured shape of a denial (p1e, h5): the tool, its use id, its input
    permission_denials: denied.map((file, i) => ({
      tool_name: 'Write',
      tool_use_id: `toolu_fake_${i + 1}`,
      tool_input: { file_path: file },
    })),
  };
  const out =
    subtype === 'success'
      ? {
          ...base,
          result: act.resultText ?? JSON.stringify(act.output ?? {}),
          ...(act.output !== undefined ? { structured_output: act.output } : {}),
        }
      : { ...base, errors: [act.resultText ?? `fake claude: ${subtype}`] };
  fs.writeSync(1, JSON.stringify(out) + '\n');
  process.exitCode = act.exitCode ?? (subtype === 'success' ? 0 : 1);
}
