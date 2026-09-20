import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  editAllowed,
  hookSettings,
  realpathAhead,
  shellQuote,
  siteBin,
  siteEnv,
  UnresolvedPathError,
  writeHookSettings,
} from '../../src/orchestrate/hooks';
import { readJson, writeJson } from '../../src/pack/io';
import { PackPaths } from '../../src/pack/paths';
import { HookSettingsSchema } from '../../src/pack/schemas';

const bin = path.resolve('bin/site');
const env = { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` };
let root: string;
beforeAll(async () => {
  // realpath: macos hands out /var/folders/..., a symlink, and editAllowed now resolves the
  // target through its existing ancestors, so an allowed list spelled through the link would
  // never match. the orchestrator realpaths the project once; the test does the same
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'site-hooks-')));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const input = (i: HookSettingsInputLike) => i;
type HookSettingsInputLike = Parameters<typeof hookSettings>[0];

describe('editAllowed', () => {
  it('allows a listed file, by absolute or cwd-relative path', () => {
    expect(editAllowed('/p/src/a.tsx', '/p', ['/p/src/a.tsx'])).toBe(true);
    expect(editAllowed('src/a.tsx', '/p', ['/p/src/a.tsx'])).toBe(true);
  });
  it('allows anything under a listed dir and nothing that only shares its prefix', () => {
    expect(
      editAllowed('/p/src/features/index/components/x.tsx', '/p', ['/p/src/features/index/']),
    ).toBe(true);
    expect(editAllowed('/p/src/features/index', '/p', ['/p/src/features/index/'])).toBe(true);
    expect(editAllowed('/p/src/features/index2/x.tsx', '/p', ['/p/src/features/index/'])).toBe(
      false,
    );
    expect(editAllowed('/p/src/a.tsx.bak', '/p', ['/p/src/a.tsx'])).toBe(false);
    expect(editAllowed('/p/tailwind.config.cjs', '/p', ['/p/src/features/index/'])).toBe(false);
    expect(editAllowed('/etc/passwd', '/p', [])).toBe(false);
  });
  it('compares one spelling of a path, so the caller owes it one resolved project root', () => {
    // the same file through a symlinked parent is a different string and is refused: the
    // orchestrator realpaths the project once and builds both the entries and the cwd from it
    expect(editAllowed('/private/p/src/a.tsx', '/private/p', ['/p/src/a.tsx'])).toBe(false);
  });
  it('follows a symlink under an allowed dir to where it points, and refuses it there', async () => {
    const proj = path.join(root, 'link-proj');
    const outside = path.join(root, 'outside');
    await fs.mkdir(path.join(proj, 'src'), { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(proj, 'src', 'shared'), 'dir');
    const allowed = [path.join(proj, 'src') + '/'];
    // the no-op negative: a file under the dir that is not there yet is allowed as before
    expect(editAllowed('src/new.tsx', proj, allowed)).toBe(true);
    expect(editAllowed(path.join(proj, 'src', 'deeper', 'new.tsx'), proj, allowed)).toBe(true);
    // through the link the write lands in `outside`, which is on no list
    expect(editAllowed('src/shared/x.tsx', proj, allowed)).toBe(false);
    expect(editAllowed(path.join(proj, 'src', 'shared', 'x.tsx'), proj, allowed)).toBe(false);
    // and the resolved spelling of an allowed dir still matches itself
    expect(editAllowed(path.join(outside, 'x.tsx'), proj, [outside + '/'])).toBe(true);
  });
  it('allows a link whose target is inside an allowed dir, under the spelling it resolves to', async () => {
    // the other half of the symlink rule: resolving ahead refuses what leaves the list, and it
    // must not refuse what stays on it. a generated feature dir with a link to a sibling dir
    // inside the same feature is an ordinary thing for a worker to write through
    const proj = path.join(root, 'inside-link-proj');
    const feature = path.join(proj, 'src', 'features', 'x');
    await fs.mkdir(path.join(feature, 'components'), { recursive: true });
    const allowed = [feature + '/'];
    // the no-op negative: the target dir itself is on the list and its files are allowed
    expect(editAllowed(path.join(feature, 'components', 'card.tsx'), proj, allowed)).toBe(true);
    await fs.symlink(path.join(feature, 'components'), path.join(feature, 'ui'), 'dir');
    // through the link the write lands in components/, which is under the allowed dir
    expect(editAllowed('src/features/x/ui/card.tsx', proj, allowed)).toBe(true);
    expect(editAllowed(path.join(feature, 'ui', 'card.tsx'), proj, allowed)).toBe(true);
    // and it is the resolved spelling that is judged: the same link with only the link's own
    // dir on the list is refused, because what it resolves to is not under it
    expect(
      editAllowed('src/features/x/ui/card.tsx', proj, [path.join(proj, 'src', 'other') + '/']),
    ).toBe(false);
    expect(realpathAhead(path.join(feature, 'ui', 'card.tsx'))).toBe(
      path.join(feature, 'components', 'card.tsx'),
    );
  });

  it('refuses a symlink that dangles or loops rather than reading it as a file not there yet', async () => {
    const proj = path.join(root, 'dangling-proj');
    const feature = path.join(proj, 'src', 'features', 'x');
    const outside = path.join(root, 'dangling-outside');
    await fs.mkdir(feature, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    const allowed = [feature + '/'];
    // the no-op negative: a plain file that is not there yet is allowed, as it has to be
    expect(editAllowed('src/features/x/new.tsx', proj, allowed)).toBe(true);
    // a link whose target does not exist fails realpath with the same ENOENT a missing file
    // does, and it is the first write through it that lands in `outside`: nothing exists there
    // for a later check to catch
    await fs.symlink(path.join(outside, 'pwned.tsx'), path.join(feature, 'esc.tsx'));
    expect(editAllowed('src/features/x/esc.tsx', proj, allowed)).toBe(false);
    expect(() => realpathAhead(path.join(feature, 'esc.tsx'))).toThrow(UnresolvedPathError);
    await expect(fs.stat(path.join(outside, 'pwned.tsx'))).rejects.toThrow(/ENOENT/);
    // a loop names nowhere at all
    await fs.symlink(path.join(feature, 'b.tsx'), path.join(feature, 'a.tsx'));
    await fs.symlink(path.join(feature, 'a.tsx'), path.join(feature, 'b.tsx'));
    expect(editAllowed('src/features/x/a.tsx', proj, allowed)).toBe(false);
    // a dangling link in the middle takes the whole path with it, target or no target
    await fs.symlink(path.join(outside, 'gone'), path.join(feature, 'sub'), 'dir');
    expect(editAllowed('src/features/x/sub/new.tsx', proj, allowed)).toBe(false);
  });
});

describe('hookSettings', () => {
  it("quotes for sh and finds this checkout's bin/site", async () => {
    expect(shellQuote("it's here")).toBe(`'it'\\''s here'`);
    expect(siteBin()).toBe(bin);
    await expect(fs.stat(siteBin())).resolves.toBeTruthy();
  });

  it('writes the reference shape: an edit hook on the edit tools and a stop hook on everything', async () => {
    const i = input({
      site: '/x/bin/site',
      pack: '/packs/x',
      unitId: 'page:index#s02-hero',
      target: 'http://127.0.0.1:3000',
      allowedFile: '/packs/x/runs/r/u/round-1/allowed-files.json',
      stopStateFile: '/packs/x/runs/r/u/round-1/stop-hook.json',
      verifyOutDir: '/packs/x/runs/r/u/round-1/verify-hook',
      maxBlocks: 3,
      gate: 0.002,
    });
    const s = hookSettings(i);
    expect(HookSettingsSchema.safeParse(s).success).toBe(true);
    expect(s.hooks.PreToolUse![0]!.matcher).toBe('Edit|Write|MultiEdit|NotebookEdit');
    // both hooks are given the pack: both read runs/.lock to see whether the orchestrator
    // that started this worker is still alive
    expect(s.hooks.PreToolUse![0]!.hooks[0]!.command).toBe(
      `'/x/bin/site' hook edit --pack '/packs/x' --allowed '/packs/x/runs/r/u/round-1/allowed-files.json'`,
    );
    expect(s.hooks.Stop![0]!.matcher).toBeUndefined();
    expect(s.hooks.Stop![0]!.hooks[0]!.command).toBe(
      `'/x/bin/site' hook stop --pack '/packs/x' --unit 'page:index#s02-hero' --target 'http://127.0.0.1:3000' --out '/packs/x/runs/r/u/round-1/verify-hook' --state '/packs/x/runs/r/u/round-1/stop-hook.json' --max-blocks 3 --gate 0.002`,
    );
    expect(s.hooks.Stop![0]!.hooks[0]!.timeout).toBe(600);
    // claude runs a hook command as one plain command line: an inline `sh -c '...'` whose
    // quotes are escaped through json ran nothing on 2.1.278 (measured), so every command is
    // the quoted binary and its arguments with no shell wrapper in front
    for (const group of [...s.hooks.PreToolUse!, ...s.hooks.Stop!]) {
      for (const h of group.hooks) {
        expect(h.command.startsWith(`'/x/bin/site' hook `)).toBe(true);
        expect(h.command).not.toContain('sh -c');
      }
    }
    const file = path.join(root, 'settings.json');
    await writeHookSettings(file, { ...i, gate: undefined });
    const back = await readJson(HookSettingsSchema, file);
    expect(back.hooks.Stop![0]!.hooks[0]!.command.endsWith('--max-blocks 3')).toBe(true);
  });
});

describe('site hook edit', () => {
  const run = (allowed: string, hookInput: unknown, pack = path.join(root, 'no-such-pack')) =>
    execa(bin, ['hook', 'edit', '--pack', pack, '--allowed', allowed], {
      env,
      input: JSON.stringify(hookInput),
      reject: false,
    });

  it('says nothing for an allowed edit or a non-edit tool, and denies the rest with a reason', async () => {
    const cwd = path.join(root, 'proj');
    const allowed = path.join(root, 'allowed.json');
    await writeJson(allowed, [path.join(cwd, 'src/a.tsx'), path.join(cwd, 'src/features/index/')]);
    const base = { session_id: 's', transcript_path: '', cwd, permission_mode: 'dontAsk' };
    const ok = await run(allowed, {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(cwd, 'src/a.tsx') },
    });
    expect(ok.exitCode, ok.stderr).toBe(0);
    expect(ok.stdout).toBe('');
    const bash = await run(allowed, {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(bash.exitCode).toBe(0);
    expect(bash.stdout).toBe('');
    const no = await run(allowed, {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: path.join(cwd, 'src/b.tsx') },
    });
    expect(no.exitCode).toBe(0);
    const decision = JSON.parse(no.stdout) as { hookSpecificOutput: Record<string, string> };
    expect(decision.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('src/b.tsx');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('src/a.tsx');
    const nb = await run(allowed, {
      ...base,
      hook_event_name: 'PreToolUse',
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: path.join(cwd, 'x.ipynb') },
    });
    expect(JSON.parse(nb.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies, in one line, rather than failing open when the hook itself cannot run', async () => {
    // a non-zero exit is "carry on" to the hook protocol, so every failure here is a denial
    const gone = path.join(root, 'no-such-allowed.json');
    const missing = await run(gone, {
      session_id: 's',
      transcript_path: '',
      cwd: path.join(root, 'proj'),
      permission_mode: 'dontAsk',
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/etc/passwd' },
    });
    expect(missing.exitCode, missing.stderr).toBe(0);
    const reason = JSON.parse(missing.stdout).hookSpecificOutput;
    expect(reason.permissionDecision).toBe('deny');
    expect(reason.permissionDecisionReason).toContain('site hook edit failed');
    expect(reason.permissionDecisionReason).toContain(gone);
    expect(reason.permissionDecisionReason).not.toContain('\n');
    for (const input of ['', 'not json', JSON.stringify({ tool_name: 'Write' })]) {
      const bad = await execa(
        bin,
        ['hook', 'edit', '--pack', path.join(root, 'no-such-pack'), '--allowed', gone],
        { env, input, reject: false },
      );
      expect(bad.exitCode, bad.stderr).toBe(0);
      const decision = JSON.parse(bad.stdout).hookSpecificOutput;
      expect(decision.permissionDecision, input).toBe('deny');
      expect(decision.permissionDecisionReason, input).toContain('site hook edit failed');
      expect(decision.permissionDecisionReason, input).not.toContain('\n');
    }
  });
});

describe('site hook stop', () => {
  it('holds the worker with exit 2 when the hook itself cannot run', async () => {
    // exit 2 is the protocol's blocking error; anything else would let the worker stop with the
    // unit unverified. the pack is never reached, so nothing here runs a verify.
    for (const input of ['', 'not json', JSON.stringify({ hook_event_name: 42 })]) {
      const r = await execa(
        bin,
        [
          'hook',
          'stop',
          '--pack',
          path.join(root, 'no-such-pack'),
          '--unit',
          'page:index',
          '--target',
          'http://127.0.0.1:9',
          '--out',
          path.join(root, 'verify'),
          '--state',
          path.join(root, 'stop-hook.json'),
        ],
        { env, input, reject: false },
      );
      expect(r.exitCode, input).toBe(2);
      expect(r.stdout, input).toBe('');
      expect(r.stderr, input).toMatch(/site hook stop failed/);
      expect(r.stderr.trim(), input).not.toContain('\n');
    }
  });

  it('lets the worker go when the state file it counts holds in cannot be read', async () => {
    const stateFile = path.join(root, 'corrupt-stop-hook.json');
    const args = (state: string) => [
      'hook',
      'stop',
      '--pack',
      path.join(root, 'no-such-pack'),
      '--unit',
      'page:index',
      '--target',
      'http://127.0.0.1:9',
      '--out',
      path.join(root, 'corrupt-verify'),
      '--state',
      state,
    ];
    const input = JSON.stringify({
      session_id: 's',
      transcript_path: '',
      cwd: root,
      permission_mode: 'dontAsk',
      hook_event_name: 'Stop',
    });
    // the no-op negative: a state that says it has held enough lets the worker go quietly,
    // which is the same answer the corrupt one has to give
    await writeJson(stateFile, { blocks: 3, lastVerdict: 'fail' });
    const held = await execa(bin, [...args(stateFile), '--max-blocks', '3'], {
      env,
      input,
      reject: false,
    });
    expect(held.exitCode, held.stderr).toBe(0);
    expect(held.stdout).toBe('');
    expect(held.stderr).toBe('');
    // a state the hook cannot read used to throw into the catch below, which exits 2 and holds
    // the worker: a hook that cannot count holds must not hold for ever. no verify is run
    // (the pack is not there to run one against), and the reason is on stderr
    await fs.writeFile(stateFile, '{');
    const corrupt = await execa(bin, args(stateFile), { env, input, reject: false });
    expect(corrupt.exitCode, corrupt.stderr).toBe(0);
    expect(corrupt.stdout).toBe('');
    expect(corrupt.stderr).toContain(stateFile);
    expect(corrupt.stderr).toMatch(/not held/);
    // and the file it could not read is left as it was for a person to look at
    expect(await fs.readFile(stateFile, 'utf8')).toBe('{');
  });

  it('refuses a --max-blocks that is not a whole number of 1 or more', async () => {
    const r = await execa(
      bin,
      [
        'hook',
        'stop',
        '--pack',
        'p',
        '--unit',
        'u',
        '--target',
        't',
        '--out',
        'o',
        '--state',
        's',
        '--max-blocks',
        '0',
      ],
      { env, input: '', reject: false },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/whole number/);
  });
});

describe('a hook whose orchestrator was killed', () => {
  /** a pack whose runs/.lock names the pid given: this process, or one nobody has */
  async function packHeldBy(name: string, pid: number): Promise<string> {
    const pack = path.join(root, name);
    const lock = new PackPaths(pack).lock;
    await fs.mkdir(path.dirname(lock), { recursive: true });
    await writeJson(lock, { pid, run: 'r1', startedAt: '2026-09-18T00:00:00.000Z' });
    return pack;
  }

  const stop = (pack: string) =>
    execa(
      bin,
      [
        'hook',
        'stop',
        '--pack',
        pack,
        '--unit',
        'page:index',
        '--target',
        'http://127.0.0.1:9',
        '--out',
        path.join(root, 'orphan-verify'),
        '--state',
        path.join(root, 'orphan-stop-hook.json'),
      ],
      {
        env,
        input: JSON.stringify({
          session_id: 's',
          transcript_path: '',
          cwd: root,
          permission_mode: 'dontAsk',
          hook_event_name: 'Stop',
        }),
        reject: false,
      },
    );

  const edit = (pack: string, allowed: string) =>
    execa(bin, ['hook', 'edit', '--pack', pack, '--allowed', allowed], {
      env,
      input: JSON.stringify({
        session_id: 's',
        transcript_path: '',
        cwd: root,
        permission_mode: 'dontAsk',
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: path.join(root, 'live', 'src/a.tsx') },
      }),
      reject: false,
    });

  it('lets the worker stop and denies its edits once runs/.lock names a dead pid', async () => {
    const allowed = path.join(root, 'orphan-allowed.json');
    await writeJson(allowed, [path.join(root, 'live', 'src/a.tsx')]);

    // the no-op negative: a lock naming a live process is a run still working the pack, so
    // both hooks do their usual job (the edit is on the list, so it is allowed)
    const live = await packHeldBy('live', process.pid);
    const okEdit = await edit(live, allowed);
    expect(okEdit.exitCode, okEdit.stderr).toBe(0);
    expect(okEdit.stdout).toBe('');

    // a hard kill of site build runs no cleanup: the lock is left behind naming a pid nobody
    // has. the worker would otherwise run on to its 20-minute wall clock against a dev server
    // nobody will stop, held at every stop by a hook rerunning verify for a run that is gone
    const dead = await packHeldBy('dead', 999_999);
    const released = await stop(dead);
    expect(released.exitCode, released.stderr).toBe(0);
    // no decision on stdout: the worker is free to stop, and no verify was ever run for it
    expect(released.stdout).toBe('');
    await expect(fs.stat(path.join(root, 'orphan-stop-hook.json'))).rejects.toThrow(/ENOENT/);

    const denied = await edit(dead, allowed);
    expect(denied.exitCode, denied.stderr).toBe(0);
    const decision = JSON.parse(denied.stdout).hookSpecificOutput;
    expect(decision.permissionDecision).toBe('deny');
    expect(decision.permissionDecisionReason).toBe(
      'the orchestrator that started this worker is gone',
    );
  });

  it('carries on when there is no lock to read: the hook knows nothing either way', async () => {
    // a pack with no runs/.lock names no pid at all, so the edit hook judges the path the way
    // it always did rather than reading a missing file as a dead orchestrator
    const nothing = path.join(root, 'no-lock-pack');
    await fs.mkdir(nothing, { recursive: true });
    const allowed = path.join(root, 'orphan-allowed.json');
    await writeJson(allowed, [path.join(root, 'live', 'src/a.tsx')]);
    const ok = await edit(nothing, allowed);
    expect(ok.exitCode, ok.stderr).toBe(0);
    expect(ok.stdout).toBe('');
    const empty = path.join(root, 'orphan-empty.json');
    await writeJson(empty, []);
    const outside = await edit(nothing, empty);
    const reason = JSON.parse(outside.stdout).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("is outside this unit's files");
    expect(reason).not.toContain('orchestrator');
  });
});

describe('siteEnv', () => {
  it("puts the site binary's dir first on PATH and keeps everything else", () => {
    const env = siteEnv('/x/bin/site', { EXTRA: '1', PATH: '/usr/bin' });
    expect(env['PATH']).toBe(`/x/bin${path.delimiter}/usr/bin`);
    expect(env['EXTRA']).toBe('1');
    expect(env['HOME']).toBe(process.env['HOME']);
    expect(siteEnv('/x/bin/site')['PATH']!.startsWith(`/x/bin${path.delimiter}`)).toBe(true);
    // no trailing delimiter when there is nothing to keep: posix reads the empty element it
    // would leave as the current directory, which is a dir a worker chose nothing about
    expect(siteEnv('/x/bin/site', { PATH: undefined })['PATH']).toBe('/x/bin');
    expect(siteEnv('/x/bin/site', { PATH: '' })['PATH']).toBe('/x/bin');
  });
});
