/** the orchestrator's budgets and timings. every one is overridable per call; these are the cli's defaults. */
export const ORCHESTRATE = {
  /** rounds per unit before it blocks (`--rounds`) */
  rounds: 6,
  /** workers on independent pages at once (`--parallel`) */
  parallel: 2,
  /** `--max-turns` for a builder and a reviewer */
  builderTurns: 60,
  reviewerTurns: 12,
  /** wall clock per worker call, ms */
  builderTimeoutMs: 20 * 60_000,
  reviewerTimeoutMs: 8 * 60_000,
  /** `--max-turns` and the wall clock for an explorer, and how many browser actions its brief allows it */
  explorerTurns: 40,
  explorerTimeoutMs: 15 * 60_000,
  explorerActions: 40,
  /** waits between retries of a rate-limited call; the last entry repeats */
  rateLimitBackoffMs: [60_000, 300_000, 900_000, 1_800_000],
  /** how often the Stop hook may hold a worker in one round before letting it stop */
  stopHookBlocks: 3,
  /** wall clock per compile check (tsc, eslint), ms */
  checkTimeoutMs: 5 * 60_000,
  devServer: {
    /** how long `npm run dev` may take to answer, ms */
    timeoutMs: 180_000,
    pollMs: 500,
    /** SIGTERM, then SIGKILL after this, ms */
    stopGraceMs: 5_000,
  },
};

/**
 * how many consecutive holds claude honours from a Stop hook before it stops asking. measured
 * on 2.1.278 with an always-blocking hook: the hook was called nine times (`stop_hook_active`
 * false once, then true eight times), each hold cost one turn, and the run then finished
 * `success` with `num_turns` 10. a cap of holds per round at or past this number asks for a
 * hold the binary never grants, so `stopHookBlocks` stays under it.
 */
export const STOP_HOOK_OVERRIDE = 9;

/**
 * the turn budget's two bounds, checked once before a run starts anything: every hold must be
 * one the binary honours, and the builder must have turns left for the work once every hold
 * has cost one. null when the budget is sound, else the reason for the error.
 */
export function budgetProblem(turns: { builder: number }, stopHookBlocks: number): string | null {
  if (stopHookBlocks >= STOP_HOOK_OVERRIDE) {
    return `stopHookBlocks ${stopHookBlocks} is not under claude's override at ${STOP_HOOK_OVERRIDE} consecutive holds; the hook would be ignored from the ${STOP_HOOK_OVERRIDE}th`;
  }
  if (turns.builder <= stopHookBlocks + 1) {
    return `builder turns ${turns.builder} leave no room for the work: each of ${stopHookBlocks} stop-hook holds costs a turn`;
  }
  return null;
}

/**
 * what a rejected api call looks like in claude's output when the account's window is spent
 * or the api is overloaded. the documented signals are `api_error_status` 429 (a quota
 * rejection) and 529 (overloaded), the `rate_limit` error category and the `credits_required`
 * code; the wording of a subscription window rejection is not documented, so the text is
 * matched too. only `rate_limited` waits and retries the same round.
 * a real window rejection has not been provoked (it needs a spent window, which no probe can
 * arrange), so the wording stays a guess; the 429 status path is what the fake prints and what
 * round.test.ts's rate-limit test proves.
 * claude: tune the wording the first time a real run logs one (the round's builder.stderr.txt)
 */
export const RATE_LIMIT_PATTERN =
  /rate.?limit|usage limit|too many requests|credits_required|overloaded|\b429\b|\b529\b/i;

/** `--tools`: the built-in set a builder may use; glob and grep are named because macos leaves them out of the default set */
export const BUILDER_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];
/**
 * `--allowedTools`: what runs without a prompt (and under dontAsk, what runs at all). every
 * Bash rule is exact, because no hook sees a Bash call: the edit hook matches the edit tools
 * only, so a rule with a wildcard tail is the whole flag surface of that command. `--fix` on
 * either linter rewrites a parallel worker's files, `npx tsc --outDir` writes outside the
 * allowed list, `npm run dev` starts a second dev server the orchestrator never stops (the
 * brief names the orchestrator's), and a bare `site verify` reaches any pack. the round adds
 * its own `Bash(site verify --pack <root> --unit <id> *)` rules, so the worker may gate its own
 * unit. both `Bash(cmd *)` and `Bash(cmd:*)` auto-approve `cmd x` on 2.1.278 (measured), so the
 * space-star form stays. the round adds `site shot` the same way (shotRuleFor).
 */
export const BUILDER_ALLOWED = [
  // `Read` is unqualified on purpose: measured on 2026-09-20, a `Read(<dir>/**)` rule does not
  // restrict reads under `--permission-mode dontAsk` (a worker allowed `Read(<here>/r5/in/**)`
  // read a file outside it with no denial), so a path rule would read as a bound that is not
  // one. the pack comes through `--add-dir` and the project is the cwd; what a worker may
  // change is bounded by the edit hook, not by this
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(npx tsc --noEmit)',
  'Bash(npx next lint)',
  'Bash(npx next lint --max-warnings 0)',
];

/**
 * a value as a model may type it: bare, in double quotes, in single quotes. the matcher
 * compares text and does not unquote first (measured 2026-09-20: `touch "r3.txt"` is denied by
 * `Bash(touch r3.txt *)` and approved by `Bash(touch "r3.txt" *)`), and on the second real run
 * every denied `site verify` and `site shot` was the brief's own command with the pack path in
 * double quotes. three spellings of the pack times three of the unit is nine rules per command.
 */
const SPELLINGS = ['', '"', "'"];
function spellings(value: string): string[] {
  return SPELLINGS.map((q) => `${q}${value}${q}`);
}

function rulesFor(command: string, root: string, unitId: string): string[] {
  return spellings(root).flatMap((pack) =>
    spellings(unitId).map((unit) => `Bash(${command} --pack ${pack} --unit ${unit} *)`),
  );
}

/** the round's own rules: this worker may gate this unit in this pack, and no other. */
export function verifyRuleFor(root: string, unitId: string): string[] {
  return rulesFor('site verify', root, unitId);
}

/**
 * the round's other rules: this worker may shoot this unit in this pack, and no other. the
 * pack and the unit are pinned and nothing else is, the way the verify rules are: the approved
 * command carries `--target` and `--out` after them, so there is always a tail for the `*` to
 * match, and the brief names this round's own shots dir as the `--out` to write into. what no
 * prefix rule can cover (a `cd` in front, `./bin/site`, a flag moved, a pipe after) is what the
 * brief's "exactly as printed" sentence is for.
 */
export function shotRuleFor(root: string, unitId: string): string[] {
  return rulesFor('site shot', root, unitId);
}

/** the reviewer reads and never edits; `Read` is unbounded by design, for the reason above */
export const REVIEWER_TOOLS = ['Read', 'Glob', 'Grep'];
export const REVIEWER_ALLOWED = ['Read', 'Glob', 'Grep'];

/** a compile check run in the project after the builder and before verify */
export interface Check {
  name: string;
  command: string;
  args: string[];
}
export const DEFAULT_CHECKS: Check[] = [
  { name: 'tsc', command: 'npx', args: ['tsc', '--noEmit'] },
  { name: 'eslint', command: 'npx', args: ['next', 'lint', '--max-warnings', '0'] },
];
