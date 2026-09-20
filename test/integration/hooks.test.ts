import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../helpers/serve';
import { openSession, type Session } from '../../src/capture/session';
import { explore } from '../../src/capture/explore';
import { captureAll } from '../../src/capture/capture-all';
import { readJson, writeJson } from '../../src/pack/io';
import { StopHookStateSchema, WorkerOutputSchema } from '../../src/pack/schemas';
import { siteBin, writeHookSettings } from '../../src/orchestrate/hooks';
import { runWorker } from '../../src/orchestrate/worker';
import { briefHeader } from '../../src/orchestrate/brief';
import {
  childEnv,
  DONE,
  FAKE_CLAUDE,
  readScenarioState,
  writeScenario,
} from '../helpers/fake-claude';

const bin = path.resolve('bin/site');
const env = { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` };
let server: Awaited<ReturnType<typeof serveStatic>>;
let mutated: Awaited<ReturnType<typeof serveStatic>>;
let session: Session;
let root: string;
let work: string;

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  mutated = await serveStatic(path.resolve('test/fixtures/site-mutated'));
  session = await openSession({});
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-pack-hooks-'));
  // realpath: macos hands out /var/folders/..., a symlink, and a worker's process.cwd() is the
  // resolved /private/var/..., which no allowed-files entry spelled the other way would match
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'site-hooks-work-')));
  await explore({ root, url: `${server.url}/`, depth: 0, scope: [], session, states: false });
  await captureAll({ root, session });
}, 600_000);
afterAll(async () => {
  await session.close();
  await server.close();
  await mutated.close();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
});

const stopInput = (cwd: string, active = false) =>
  JSON.stringify({
    session_id: 's',
    transcript_path: '',
    cwd,
    permission_mode: 'dontAsk',
    hook_event_name: 'Stop',
    stop_hook_active: active,
    last_assistant_message: '',
  });

describe('site hook stop', () => {
  it('lets a worker stop when verify passes, and records the verdict', async () => {
    const dir = path.join(work, 'pass');
    const state = path.join(dir, 'stop-hook.json');
    const r = await execa(
      bin,
      [
        'hook',
        'stop',
        '--pack',
        root,
        '--unit',
        'page:index#s02-hero-know-before-you-go',
        '--target',
        server.url,
        '--out',
        path.join(dir, 'verify'),
        '--state',
        state,
      ],
      { env, input: stopInput(dir), reject: false },
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe('');
    expect(await readJson(StopHookStateSchema, state)).toEqual({ blocks: 0, lastVerdict: 'pass' });
    await expect(fs.stat(path.join(dir, 'verify', 'verify.json'))).resolves.toBeTruthy();
  }, 300_000);

  it('holds a worker while verify fails, up to --max-blocks, then lets it go', async () => {
    const dir = path.join(work, 'fail');
    const state = path.join(dir, 'stop-hook.json');
    const args = [
      'hook',
      'stop',
      '--pack',
      root,
      '--unit',
      'page:index#s02-hero-know-before-you-go',
      '--target',
      mutated.url,
      '--out',
      path.join(dir, 'verify'),
      '--state',
      state,
      '--max-blocks',
      '2',
    ];
    const first = await execa(bin, args, { env, input: stopInput(dir), reject: false });
    expect(first.exitCode, first.stderr).toBe(0);
    const decision = JSON.parse(first.stdout) as { decision: string; reason: string };
    expect(decision.decision).toBe('block');
    expect(decision.reason).toMatch(/verify failed \(1\/2\)/);
    expect(decision.reason).toContain('FAIL');
    expect(decision.reason).toContain('look at:');
    expect(decision.reason).toContain('diff.png');
    expect(await readJson(StopHookStateSchema, state)).toEqual({ blocks: 1, lastVerdict: 'fail' });
    const second = await execa(bin, args, { env, input: stopInput(dir, true), reject: false });
    expect(JSON.parse(second.stdout).reason).toMatch(/\(2\/2\)/);
    const third = await execa(bin, args, { env, input: stopInput(dir, true), reject: false });
    expect(third.exitCode).toBe(0);
    expect(third.stdout).toBe('');
    expect((await readJson(StopHookStateSchema, state)).blocks).toBe(2);
  }, 300_000);
});

describe('the fake claude honours the settings file', () => {
  it('drops the edit the PreToolUse hook denies, is held by the Stop hook, and runs out of turns when held too often', async () => {
    const dir = path.join(work, 'fake');
    const cwd = path.join(dir, 'project');
    await fs.mkdir(cwd, { recursive: true });
    const allowedFile = path.join(dir, 'allowed-files.json');
    await writeJson(allowedFile, [path.join(cwd, 'src/allowed.tsx'), path.join(cwd, 'src/ok/')]);
    const settings = path.join(dir, 'settings.json');
    const stopState = path.join(dir, 'stop-hook.json');
    await writeHookSettings(settings, {
      site: siteBin(),
      pack: root,
      unitId: 'page:index#s02-hero-know-before-you-go',
      target: mutated.url,
      allowedFile,
      stopStateFile: stopState,
      verifyOutDir: path.join(dir, 'verify-hook'),
      maxBlocks: 2,
    });
    const scenario = await writeScenario(path.join(dir, 'scenario.json'), {
      calls: [
        {
          when: {},
          times: 2,
          do: {
            writeFiles: { 'src/allowed.tsx': 'a', 'src/ok/x.tsx': 'b', 'src/nope.tsx': 'c' },
            output: DONE,
          },
        },
      ],
    });
    const call = (maxTurns: number, outDir: string) => ({
      role: 'builder' as const,
      claude: FAKE_CLAUDE,
      cwd,
      brief: `${briefHeader('builder', 'page:index#s02-hero-know-before-you-go', 1)}\n`,
      maxTurns,
      timeoutMs: 240_000,
      tools: ['Read', 'Edit', 'Write'],
      allowedTools: ['Read', 'Edit', 'Write'],
      settingsFile: settings,
      addDirs: [root],
      schema: WorkerOutputSchema,
      outDir,
      files: {
        brief: 'brief.md',
        stdout: 'builder.stdout.txt',
        stderr: 'builder.stderr.txt',
        record: 'builder.json',
      },
      env: { ...childEnv(scenario), PATH: env.PATH },
    });
    // enough turns: held twice (the verify against the mutated site fails), then let go, done
    const held = await runWorker(call(10, path.join(dir, 'r1')));
    expect(held.outcome).toBe('done');
    expect(held.record.numTurns).toBe(3);
    await expect(fs.readFile(path.join(cwd, 'src/allowed.tsx'), 'utf8')).resolves.toBe('a');
    await expect(fs.readFile(path.join(cwd, 'src/ok/x.tsx'), 'utf8')).resolves.toBe('b');
    await expect(fs.stat(path.join(cwd, 'src/nope.tsx'))).rejects.toThrow();
    const state = await readScenarioState(scenario);
    expect(state.calls[0]!.denied).toEqual([path.join(cwd, 'src/nope.tsx')]);
    expect(state.calls[0]!.stopBlocks).toBe(2);
    expect(await readJson(StopHookStateSchema, stopState)).toEqual({
      blocks: 2,
      lastVerdict: 'fail',
    });
    // the denial the result carries names the tool, the call it belongs to and what it asked for
    expect(held.result?.permission_denials).toHaveLength(1);
    const denial = held.result!.permission_denials![0] as {
      tool_name: string;
      tool_use_id: string;
      tool_input: { file_path: string };
    };
    expect(denial.tool_name).toBe('Write');
    expect(denial.tool_use_id).toEqual(expect.any(String));
    expect(denial.tool_use_id.length).toBeGreaterThan(0);
    expect(denial.tool_input.file_path).toBe(path.join(cwd, 'src/nope.tsx'));
    // two turns: the first hold spends the second turn, the next hold is past the budget
    await fs.rm(stopState, { force: true });
    const spent = await runWorker(call(2, path.join(dir, 'r2')));
    expect(spent.outcome).toBe('turns_exhausted');
  }, 600_000);
});
