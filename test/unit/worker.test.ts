import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJson } from '../../src/pack/io';
import { WorkerOutputSchema, WorkerRunSchema } from '../../src/pack/schemas';
import {
  argsFor,
  classify,
  FORCE_KILL_AFTER_MS,
  runWorker,
  stripClaudeEnv,
  workerEnv,
  type RawRun,
} from '../../src/orchestrate/worker';
import {
  BUILDER_ALLOWED,
  BUILDER_TOOLS,
  budgetProblem,
  ORCHESTRATE,
  shotRuleFor,
  STOP_HOOK_OVERRIDE,
  verifyRuleFor,
} from '../../src/orchestrate/defaults';
import { briefHeader, parseBriefHeader } from '../../src/orchestrate/brief';
import {
  childEnv,
  DONE,
  FAKE_CLAUDE,
  readScenarioState,
  writeScenario,
} from '../helpers/fake-claude';

let root: string;
beforeAll(async () => {
  // realpath: macos hands out /var/folders/..., a symlink, and a child's process.cwd() is
  // always the resolved path, so the fake's record would never match the dir we passed
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'site-worker-')));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const result = (extra: Record<string, unknown>) =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 3,
    session_id: 's1',
    total_cost_usd: 0.5,
    duration_ms: 10,
    ...extra,
  });
const raw = (extra: Partial<RawRun>): RawRun => ({
  exitCode: 0,
  timedOut: false,
  stdout: '',
  stderr: '',
  spawnError: null,
  ...extra,
});

describe('argsFor', () => {
  it('builds the verified flag set, one comma-joined value per variadic flag', () => {
    expect(
      argsFor({
        maxTurns: 6,
        tools: ['Read', 'Edit'],
        allowedTools: ['Read', 'Bash(npx tsc *)'],
        settingsFile: null,
        addDirs: [],
        schema: WorkerOutputSchema,
      }),
    ).toEqual([
      '-p',
      '--output-format',
      'json',
      '--max-turns',
      '6',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--no-session-persistence',
      '--setting-sources',
      'project',
      '--tools',
      'Read,Edit',
      '--allowedTools',
      'Read,Bash(npx tsc *)',
      '--json-schema',
      // no `$schema` key: 2.1.278 refuses the 2020-12 uri zod stamps by default, and the body
      // is draft-7's (measured on the first real run)
      JSON.stringify({
        type: 'object',
        properties: {
          summary: { type: 'string' },
          filesTouched: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
        },
        required: ['summary', 'filesTouched', 'notes'],
        additionalProperties: false,
      }),
    ]);
  });

  it("emits the round's own verify rules and no wildcard bash rule beside it", () => {
    // the no-op negative: the defaults alone name no pack and no unit, so nothing a worker is
    // handed by default reaches another pack
    expect(BUILDER_ALLOWED.join(',')).not.toContain('site verify');
    expect(BUILDER_ALLOWED).toEqual([
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'Bash(npx tsc --noEmit)',
      'Bash(npx next lint)',
      'Bash(npx next lint --max-warnings 0)',
    ]);
    // no hook sees a Bash call, so an exact rule is the only bound on one: --fix rewrites a
    // parallel worker's files, --outDir writes outside the allowed list, and `npm run dev`
    // starts a server the orchestrator never stops
    for (const rule of BUILDER_ALLOWED) {
      expect(rule.startsWith('Bash(') ? rule : 'Bash()', rule).not.toContain('*');
    }
    // nine rules per command: the matcher compares text and does not unquote first, and on the
    // second real run every denied call was the printed command with the pack path in double
    // quotes. so the pack bare, in double quotes and in single quotes, times the same three
    // spellings of the unit
    const rules = verifyRuleFor('/packs/x', 'page:index#s02-hero');
    expect(rules).toHaveLength(9);
    expect(new Set(rules).size).toBe(9);
    expect(rules[0]).toBe('Bash(site verify --pack /packs/x --unit page:index#s02-hero *)');
    expect(rules).toContain('Bash(site verify --pack "/packs/x" --unit page:index#s02-hero *)');
    expect(rules).toContain('Bash(site verify --pack "/packs/x" --unit "page:index#s02-hero" *)');
    expect(rules).toContain("Bash(site verify --pack '/packs/x' --unit 'page:index#s02-hero' *)");
    // the shot rules pin the same two values the verify rules do, and nothing after them: the
    // approved command always carries `--target ... --out ...` for the `*` to match
    const shots = shotRuleFor('/packs/x', 'page:index#s02-hero');
    expect(shots).toHaveLength(9);
    expect(shots[0]).toBe('Bash(site shot --pack /packs/x --unit page:index#s02-hero *)');
    expect(shots).toContain('Bash(site shot --pack "/packs/x" --unit page:index#s02-hero *)');
    for (const rule of [...rules, ...shots]) {
      // every rule is a prefix rule with one tail wildcard and nothing else wild
      expect(rule.endsWith(' *)'), rule).toBe(true);
      expect(rule.slice(0, -3).includes('*'), rule).toBe(false);
    }
    const args = argsFor({
      maxTurns: 6,
      tools: BUILDER_TOOLS,
      allowedTools: [...BUILDER_ALLOWED, ...rules],
      settingsFile: null,
      addDirs: [],
      schema: WorkerOutputSchema,
    });
    expect(args[args.indexOf('--allowedTools') + 1]).toBe([...BUILDER_ALLOWED, ...rules].join(','));
  });

  it('adds the settings file, every add-dir and the model when given', () => {
    const args = argsFor({
      maxTurns: 1,
      tools: ['Read'],
      allowedTools: ['Read'],
      settingsFile: '/r/settings.json',
      addDirs: ['/p', '/q'],
      schema: WorkerOutputSchema,
      model: 'sonnet',
    });
    expect(args.slice(-8)).toEqual([
      '--settings',
      '/r/settings.json',
      '--add-dir',
      '/p',
      '--add-dir',
      '/q',
      '--model',
      'sonnet',
    ]);
  });
});

describe('the worker env', () => {
  it('leaves an environment without session variables alone', () => {
    // the no-op negative: nothing here names a claude code session, so nothing goes
    const env = { PATH: '/bin', HOME: '/h', CLAUDE_EFFORT: 'high' };
    expect(stripClaudeEnv(env)).toEqual(env);
  });

  it('strips CLAUDECODE, CLAUDE_CODE_* and CLAUDE_PID and nothing else', () => {
    expect(
      stripClaudeEnv({
        PATH: '/bin',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 's',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_MESSAGING_TOKEN: 't',
        CLAUDE_PID: '42',
        CLAUDE_EFFORT: 'high',
        MY_CLAUDE_CODE: 'x',
      }),
    ).toEqual({ PATH: '/bin', CLAUDE_EFFORT: 'high', MY_CLAUDE_CODE: 'x' });
  });

  it("lays the call's variables over this process's and strips the result", () => {
    const env = workerEnv({ SITE_FAKE_SCENARIO: '/s', CLAUDECODE: '1' });
    expect(env['SITE_FAKE_SCENARIO']).toBe('/s');
    expect(env['CLAUDECODE']).toBeUndefined();
    expect(env['HOME']).toBe(process.env['HOME']);
  });
});

describe('the turn budget', () => {
  it('accepts the defaults: the holds under the override, turns left for the work', () => {
    expect(
      budgetProblem({ builder: ORCHESTRATE.builderTurns }, ORCHESTRATE.stopHookBlocks),
    ).toBeNull();
    expect(ORCHESTRATE.stopHookBlocks).toBeLessThan(STOP_HOOK_OVERRIDE);
  });

  it('refuses a cap the binary would override, and turns the holds alone would spend', () => {
    // measured on 2.1.278: nine consecutive holds are honoured, each costs a turn, then the
    // hook is ignored. a cap of nine asks for a hold that never comes
    expect(budgetProblem({ builder: 60 }, STOP_HOOK_OVERRIDE)).toMatch(/override/);
    expect(budgetProblem({ builder: 60 }, 12)).toMatch(/override/);
    expect(budgetProblem({ builder: 4 }, 3)).toMatch(/no room/);
    expect(budgetProblem({ builder: 5 }, 3)).toBeNull();
  });
});

describe('classify', () => {
  it('reads a clean success from structured_output, or from a json object in the result text', () => {
    const structured = classify(
      raw({ stdout: result({ result: 'done', structured_output: DONE }) }),
      WorkerOutputSchema,
    );
    expect(structured).toMatchObject({ outcome: 'done', output: DONE, reason: null });
    expect(structured.result?.num_turns).toBe(3);
    const fenced = classify(
      raw({ stdout: result({ result: 'all good\n```json\n' + JSON.stringify(DONE) + '\n```\n' }) }),
      WorkerOutputSchema,
    );
    expect(fenced).toMatchObject({ outcome: 'done', output: DONE });
    const bare = classify(
      raw({ stdout: result({ result: `built. ${JSON.stringify(DONE)} bye` }) }),
      WorkerOutputSchema,
    );
    expect(bare.outcome).toBe('done');
    // the result object may be the last line after chatter on stdout
    const noisy = classify(
      raw({ stdout: 'warming up\n' + result({ result: '', structured_output: DONE }) }),
      WorkerOutputSchema,
    );
    expect(noisy.outcome).toBe('done');
  });

  it('calls anything that is not the schema malformed_output, naming the field', () => {
    expect(
      classify(raw({ stdout: result({ result: 'built it, no json' }) }), WorkerOutputSchema),
    ).toMatchObject({
      outcome: 'malformed_output',
      reason: 'no json object in the result',
    });
    const short = classify(
      raw({
        stdout: result({ result: '', structured_output: { summary: 'x', filesTouched: [] } }),
      }),
      WorkerOutputSchema,
    );
    expect(short.outcome).toBe('malformed_output');
    expect(short.reason).toMatch(/notes/);
    expect(classify(raw({ stdout: 'nothing here' }), WorkerOutputSchema)).toMatchObject({
      outcome: 'malformed_output',
      reason: 'no result object on stdout',
    });
  });

  it('types a rate limit from the api status, the error category text, or a bare stderr line', () => {
    expect(
      classify(
        raw({
          exitCode: 1,
          stdout: result({ is_error: true, api_error_status: 429, result: 'limit' }),
        }),
        WorkerOutputSchema,
      ),
    ).toMatchObject({ outcome: 'rate_limited', reason: 'api 429' });
    expect(
      classify(
        raw({
          exitCode: 1,
          stdout: result({ is_error: true, result: 'API Error: 529 overloaded' }),
        }),
        WorkerOutputSchema,
      ).outcome,
    ).toBe('rate_limited');
    expect(
      classify(
        raw({ exitCode: 1, stderr: 'Claude AI usage limit reached|1758211200\n' }),
        WorkerOutputSchema,
      ),
    ).toMatchObject({ outcome: 'rate_limited' });
    expect(
      classify(
        raw({
          exitCode: 1,
          stdout: result({
            subtype: 'error_during_execution',
            is_error: true,
            errors: ['rate_limit: try later'],
          }),
        }),
        WorkerOutputSchema,
      ).outcome,
    ).toBe('rate_limited');
  });

  it('types turns, timeouts, crashes and a missing binary', () => {
    expect(
      classify(
        raw({
          exitCode: 1,
          stdout: result({ subtype: 'error_max_turns', is_error: true, errors: ['max turns'] }),
        }),
        WorkerOutputSchema,
      ),
    ).toMatchObject({ outcome: 'turns_exhausted', reason: '3 turns' });
    expect(
      classify(
        raw({ exitCode: 1, stdout: result({ terminal_reason: 'max_turns', result: '' }) }),
        WorkerOutputSchema,
      ).outcome,
    ).toBe('turns_exhausted');
    expect(classify(raw({ timedOut: true, exitCode: null }), WorkerOutputSchema)).toMatchObject({
      outcome: 'timeout',
    });
    expect(classify(raw({ exitCode: 1, stderr: 'boom' }), WorkerOutputSchema)).toMatchObject({
      outcome: 'crashed',
      reason: 'exit 1: boom',
    });
    expect(
      classify(
        raw({
          exitCode: 1,
          stdout: result({
            subtype: 'error_during_execution',
            is_error: true,
            errors: ['disk full'],
          }),
        }),
        WorkerOutputSchema,
      ),
    ).toMatchObject({ outcome: 'crashed', reason: 'error_during_execution: disk full' });
    expect(
      classify(raw({ exitCode: null, spawnError: 'spawn claude ENOENT' }), WorkerOutputSchema),
    ).toMatchObject({
      outcome: 'crashed',
      reason: 'spawn claude ENOENT',
    });
  });

  it('types a run that never answered its json schema as malformed, not as a crash', () => {
    // the binary ran and the model answered; what it answered is what the schema refused, and
    // that is the same failure as a result with no json in it: a round to retry
    expect(
      classify(
        raw({
          exitCode: 1,
          stdout: result({
            subtype: 'error_max_structured_output_retries',
            is_error: true,
            errors: ['gave up after 3 tries'],
          }),
        }),
        WorkerOutputSchema,
      ),
    ).toMatchObject({
      outcome: 'malformed_output',
      reason: 'error_max_structured_output_retries: gave up after 3 tries',
    });
  });
});

describe('the brief header', () => {
  it('round-trips through the fake and the runner', () => {
    const text = `${briefHeader('reviewer', 'page:index#s02-hero', 3)}\n# review\n`;
    expect(parseBriefHeader(text)).toEqual({
      role: 'reviewer',
      unit: 'page:index#s02-hero',
      round: 3,
    });
    expect(parseBriefHeader('# no header')).toBeNull();
  });

  it('knows the explorer role', () => {
    expect(parseBriefHeader(`${briefHeader('explorer', 'page:index', 1)}\n`)).toEqual({
      role: 'explorer',
      unit: 'page:index',
      round: 1,
    });
  });
});

describe('runWorker with the fake claude', () => {
  const call = (outDir: string, scenario: string, extra: Record<string, unknown> = {}) => ({
    role: 'builder' as const,
    claude: FAKE_CLAUDE,
    cwd: outDir,
    brief: `${briefHeader('builder', 'page:index#s02-hero', 1)}\n# build\n`,
    maxTurns: 4,
    timeoutMs: 10_000,
    tools: ['Read', 'Edit', 'Write'],
    allowedTools: ['Read', 'Edit', 'Write'],
    settingsFile: null,
    addDirs: [],
    schema: WorkerOutputSchema,
    outDir,
    files: {
      brief: 'brief.md',
      stdout: 'builder.stdout.txt',
      stderr: 'builder.stderr.txt',
      record: 'builder.json',
    },
    env: childEnv(scenario),
    ...extra,
  });

  it('runs a scripted done call, writes the files it was told to, and logs everything', async () => {
    const dir = path.join(root, 'done');
    const scenario = await writeScenario(path.join(dir, 'scenario.json'), {
      calls: [
        {
          when: { role: 'builder' },
          do: { writeFiles: { 'src/a.tsx': 'export {};\n' }, output: DONE },
        },
      ],
    });
    const r = await runWorker(call(dir, scenario));
    expect(r.outcome).toBe('done');
    expect(r.output).toEqual(DONE);
    expect(r.record).toMatchObject({
      role: 'builder',
      outcome: 'done',
      exitCode: 0,
      numTurns: 1,
      output: DONE,
    });
    expect(WorkerRunSchema.safeParse(r.record).success).toBe(true);
    expect(await fs.readFile(path.join(dir, 'src', 'a.tsx'), 'utf8')).toBe('export {};\n');
    expect(await fs.readFile(path.join(dir, 'brief.md'), 'utf8')).toContain('role=builder');
    expect(JSON.parse(await fs.readFile(path.join(dir, 'builder.stdout.txt'), 'utf8')).type).toBe(
      'result',
    );
    await expect(fs.stat(path.join(dir, 'builder.stderr.txt'))).resolves.toBeTruthy();
    expect((await readJson(WorkerRunSchema, path.join(dir, 'builder.json'))).outcome).toBe('done');
    const state = await readScenarioState(scenario);
    expect(state.uses).toEqual([1]);
    expect(state.calls[0]).toMatchObject({
      index: 0,
      role: 'builder',
      unit: 'page:index#s02-hero',
      round: 1,
      cwd: dir,
    });
    expect(state.calls[0]!.argv).toContain('--max-turns');
  });

  it('runs from inside a claude code session: the session variables never reach the worker', async () => {
    const dir = path.join(root, 'nested');
    const scenario = await writeScenario(path.join(dir, 'scenario.json'), {
      calls: [{ when: {}, do: { output: DONE } }],
    });
    // the fake refuses to run with CLAUDECODE set, as the binary does (measured on 2.1.278)
    const refused = await execa(FAKE_CLAUDE, ['-p'], {
      env: { ...childEnv(scenario), CLAUDECODE: '1' },
      reject: false,
      input: `${briefHeader('builder', 'page:index', 1)}\n`,
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/CLAUDECODE is set/);
    // the runner strips them, so the same call through it is answered
    const r = await runWorker(
      call(dir, scenario, {
        env: {
          ...childEnv(scenario),
          CLAUDECODE: '1',
          CLAUDE_CODE_SESSION_ID: 'x',
          CLAUDE_PID: '7',
        },
      }),
    );
    expect(r.outcome).toBe('done');
    expect(r.record.stopReason).toBe('end_turn');
    // the refused call never claimed an entry; the answered one did
    expect((await readScenarioState(scenario)).calls).toHaveLength(1);
  });

  it('refuses a flag the real binary does not know, before doing anything', async () => {
    const dir = path.join(root, 'flag');
    const scenario = await writeScenario(path.join(dir, 'scenario.json'), { calls: [] });
    const r = await execa(FAKE_CLAUDE, ['-p', '--bogus'], {
      env: childEnv(scenario),
      reject: false,
      input: '',
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/unknown option '--bogus'/);
  });

  it('refuses a positional argument: the brief goes on stdin and nothing goes on argv', async () => {
    const dir = path.join(root, 'positional');
    const scenario = await writeScenario(path.join(dir, 'scenario.json'), { calls: [] });
    const r = await execa(FAKE_CLAUDE, ['-p', 'build the hero'], {
      env: childEnv(scenario),
      reject: false,
      input: '',
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/unexpected argument 'build the hero'/);
  });

  it('takes the json schema argsFor builds and refuses one the binary cannot resolve', async () => {
    const dir = path.join(root, 'schema-flag');
    await fs.mkdir(dir, { recursive: true });
    const scenario = await writeScenario(path.join(dir, 'scenario.json'), {
      calls: [{ when: {}, do: { output: DONE } }],
    });
    const input = `${briefHeader('builder', 'page:index', 1)}\n`;
    const args = argsFor({
      maxTurns: 1,
      tools: ['Read'],
      allowedTools: ['Read'],
      settingsFile: null,
      addDirs: [],
      schema: WorkerOutputSchema,
    });
    // the no-op negative: what the runner builds today is taken, so what the check below catches
    // is the value of the flag and nothing else about the argv
    const ok = await execa(FAKE_CLAUDE, args, {
      cwd: dir,
      env: childEnv(scenario),
      reject: false,
      input,
    });
    expect(ok.exitCode, ok.stderr).toBe(0);
    // zod 4's own default stamps the 2020-12 uri, which 2.1.278 refuses at argument parsing,
    // before a turn is spent (measured on the first real run). argsFor no longer emits it, so
    // the argv here is hand-built from what it does emit
    const at = args.indexOf('--json-schema');
    const with2020 = [...args];
    with2020[at + 1] = JSON.stringify({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      ...(JSON.parse(args[at + 1]!) as Record<string, unknown>),
    });
    const bad = await execa(FAKE_CLAUDE, with2020, {
      cwd: dir,
      env: childEnv(scenario),
      reject: false,
      input,
    });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain(
      'no schema with key or ref "https://json-schema.org/draft/2020-12/schema"',
    );
    // the runner types that as a crash, which is what the round then sees
    expect(
      classify(
        raw({ exitCode: bad.exitCode, stdout: bad.stdout, stderr: bad.stderr }),
        WorkerOutputSchema,
      ),
    ).toMatchObject({ outcome: 'crashed', reason: expect.stringContaining('no schema with key') });
    // the refused call was refused before it claimed anything: only the accepted one is recorded
    expect((await readScenarioState(scenario)).calls).toHaveLength(1);
  });

  it('types a scripted rate limit, a crash, a malformed output and exhausted turns', async () => {
    const dir = path.join(root, 'outcomes');
    const scenario = await writeScenario(path.join(dir, 'scenario.json'), {
      calls: [
        { when: { round: 1 }, do: { rateLimit: true } },
        { when: { round: 2 }, do: { stdout: 'segfault\n', exitCode: 139 } },
        { when: { round: 3 }, do: { resultText: 'i am done, trust me' } },
        { when: { round: 4 }, do: { subtype: 'error_max_turns' } },
        { when: { round: 5 }, do: { output: DONE, exitCode: 0, stderr: 'a warning\n' } },
      ],
    });
    const at = (round: number) =>
      call(path.join(dir, `r${round}`), scenario, {
        brief: `${briefHeader('builder', 'page:index', round)}\n`,
      });
    expect(await runWorker(at(1))).toMatchObject({ outcome: 'rate_limited', reason: 'api 429' });
    expect(await runWorker(at(2))).toMatchObject({
      outcome: 'crashed',
      reason: 'exit 139: segfault',
    });
    expect(await runWorker(at(3))).toMatchObject({ outcome: 'malformed_output' });
    expect(await runWorker(at(4))).toMatchObject({ outcome: 'turns_exhausted' });
    const fine = await runWorker(at(5));
    expect(fine.outcome).toBe('done');
    expect(await fs.readFile(path.join(dir, 'r5', 'builder.stderr.txt'), 'utf8')).toBe(
      'a warning\n',
    );
  });

  it('kills a call that outlives its wall clock and types it timeout', async () => {
    const dir = path.join(root, 'slow');
    const scenario = await writeScenario(path.join(dir, 'scenario.json'), {
      calls: [{ when: {}, do: { sleepMs: 5_000, output: DONE } }],
    });
    const started = Date.now();
    // 2 s, not 600 ms: under load the fake needs up to 700 ms to start and record its call
    const r = await runWorker(call(dir, scenario, { timeoutMs: 2_000 }));
    expect(r.outcome).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(r.record.exitCode).toBeNull();
    // the call was recorded before the fake slept, so a killed call still spends its budget
    const state = await readScenarioState(scenario);
    expect(state.uses).toEqual([1]);
    expect(state.calls[0]).toMatchObject({ index: 0, role: 'builder', cwd: dir });
  });

  it('kills the whole group when a grandchild holds the pipes, on the timeout and on an abort', async () => {
    const dir = path.join(root, 'held');
    const scenario = await writeScenario(path.join(dir, 'scenario.json'), {
      calls: [
        { when: { round: 1 }, do: { output: DONE } },
        { when: { round: 2 }, do: { holdPipes: true, sleepMs: 60_000, output: DONE } },
        { when: { round: 3 }, do: { holdPipes: true, sleepMs: 60_000, output: DONE } },
      ],
    });
    // the sleepers this test's own calls leave: anything already on the machine is not ours
    const sleepers = async () => {
      const r = await execa('pgrep', ['-f', '-x', 'sleep 60'], { reject: false });
      return r.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .sort();
    };
    const before = await sleepers();
    const at = (round: number, extra: Record<string, unknown>) =>
      call(path.join(dir, `r${round}`), scenario, {
        brief: `${briefHeader('builder', 'page:index', round)}\n`,
        ...extra,
      });

    // the no-op negative: a call that holds nothing runs and leaves nothing behind
    expect((await runWorker(at(1, { timeoutMs: 10_000 }))).outcome).toBe('done');
    expect(await sleepers()).toEqual(before);

    // the fake leaves a `sleep 60` holding this call's stdout and stderr, the way a `site
    // verify` with its chromium does. killing the leader alone leaves it there and the await
    // on the pipes with it: measured at 2 h 29 m 36 s for a 20 minute timeout on the real run
    const startedAt = Date.now();
    const timedOut = await runWorker(at(2, { timeoutMs: 2_000 }));
    expect(timedOut.outcome).toBe('timeout');
    expect(Date.now() - startedAt).toBeLessThan(2_000 + FORCE_KILL_AFTER_MS);
    expect(await sleepers()).toEqual(before);

    // the same on an abort: a SIGINT during a builder's own verify must not hang the shutdown
    const controller = new AbortController();
    const abortedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), 1_000);
    const cancelled = await runWorker(at(3, { timeoutMs: 60_000, signal: controller.signal }));
    clearTimeout(timer);
    expect(cancelled).toMatchObject({ outcome: 'crashed', reason: 'cancelled' });
    expect(Date.now() - abortedAt).toBeLessThan(1_000 + 2 * FORCE_KILL_AFTER_MS);
    expect(await sleepers()).toEqual(before);
  }, 120_000);

  it('reports a missing binary and a call no scenario entry answers as crashed', async () => {
    const dir = path.join(root, 'missing');
    const scenario = await writeScenario(path.join(dir, 'scenario.json'), {
      calls: [{ when: { role: 'reviewer' }, do: { output: DONE } }],
    });
    const gone = await runWorker(call(dir, scenario, { claude: path.join(dir, 'no-such-claude') }));
    expect(gone.outcome).toBe('crashed');
    expect(gone.reason).toMatch(/ENOENT/);
    const unmatched = await runWorker(call(path.join(dir, 'u'), scenario));
    expect(unmatched.outcome).toBe('crashed');
    expect(unmatched.reason).toMatch(/no scenario entry for role=builder/);
    expect((await readScenarioState(scenario)).calls[0]!.index).toBeNull();
  });

  it('answers an entry as many times as it says and then moves on', async () => {
    const dir = path.join(root, 'times');
    const scenario = await writeScenario(path.join(dir, 'scenario.json'), {
      calls: [
        { when: {}, times: 2, do: { rateLimit: true } },
        { when: {}, do: { output: DONE } },
      ],
    });
    expect((await runWorker(call(path.join(dir, '1'), scenario))).outcome).toBe('rate_limited');
    expect((await runWorker(call(path.join(dir, '2'), scenario))).outcome).toBe('rate_limited');
    expect((await runWorker(call(path.join(dir, '3'), scenario))).outcome).toBe('done');
    expect((await readScenarioState(scenario)).uses).toEqual([2, 1]);
  });

  it('answers two calls at once without either losing the other from the state', async () => {
    const dir = path.join(root, 'parallel');
    // one entry is slow, so the two fakes are inside the state file at the same time: the
    // orchestrator runs workers in parallel and they share one scenario
    const scenario = await writeScenario(path.join(dir, 'scenario.json'), {
      calls: [
        { when: {}, times: 1, do: { sleepMs: 300, output: DONE } },
        { when: {}, times: 1, do: { output: DONE } },
      ],
    });
    const both = await Promise.all([
      runWorker(call(path.join(dir, 'a'), scenario)),
      runWorker(call(path.join(dir, 'b'), scenario)),
    ]);
    expect(both.map((r) => r.outcome)).toEqual(['done', 'done']);
    const state = await readScenarioState(scenario);
    expect(state.uses).toEqual([1, 1]);
    expect(state.calls).toHaveLength(2);
    expect([...state.calls.map((c) => c.index)].sort()).toEqual([0, 1]);
  });

  it('fails a call whose state file is corrupt without leaving the lock behind', async () => {
    const dir = path.join(root, 'corrupt');
    const scenario = await writeScenario(path.join(dir, 'scenario.json'), {
      calls: [{ when: {}, do: { output: DONE } }],
    });
    const stateFile = `${scenario}.state.json`;
    await fs.writeFile(stateFile, '{');
    const bad = await runWorker(call(path.join(dir, 'bad'), scenario));
    expect(bad.outcome).toBe('crashed');
    expect(bad.reason).toMatch(/is not json/);
    await expect(fs.stat(`${stateFile}.lock`)).rejects.toThrow();
    // the lock came off, so the next call is answered rather than spinning on it
    await fs.rm(stateFile, { force: true });
    expect((await runWorker(call(path.join(dir, 'good'), scenario))).outcome).toBe('done');
  });

  it('stops honouring a Stop hook after nine holds, one turn each, as the binary does', async () => {
    const dir = path.join(root, 'stop');
    const scenario = await writeScenario(path.join(dir, 'scenario.json'), {
      calls: [{ when: {}, do: { output: DONE } }],
    });
    const settingsFile = path.join(dir, 'settings.json');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      settingsFile,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: `echo '{"decision":"block","reason":"x"}'` }] },
          ],
        },
      }),
    );
    // measured (h3): the hook was called nine times, then the run finished success with
    // num_turns 10: one turn for the answer and one per hold
    const r = await runWorker(call(dir, scenario, { settingsFile, maxTurns: 20 }));
    expect(r.outcome).toBe('done');
    expect(r.result?.subtype).toBe('success');
    expect(r.record.numTurns).toBe(STOP_HOOK_OVERRIDE + 1);
    expect((await readScenarioState(scenario)).calls[0]!.stopBlocks).toBe(STOP_HOOK_OVERRIDE);
  });
});
