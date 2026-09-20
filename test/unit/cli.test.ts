import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { absoluteArg, claudeArg, gateArg, positiveIntArg, viewportArg } from '../../src/cli/args';
import { defaultPackFor } from '../../src/cli/commands/brand';
import { workerEnv } from '../../src/orchestrate/worker';

const bin = path.resolve('bin/site');
// bin/site runs `node`, so the node running the tests has to be first on the child's PATH;
// workerEnv takes this session's own variables out, and extendEnv: false on every call keeps
// execa from merging process.env back underneath them
const env = workerEnv({
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
});

describe('cli', () => {
  it('prints the version', async () => {
    const { stdout } = await execa(bin, ['--version'], { env, extendEnv: false });
    expect(stdout.trim()).toBe('0.2.0');
  });

  it('refuses a --gate that is not a number', async () => {
    const r = await execa(
      bin,
      ['verify', '--pack', 'x', '--unit', 'y', '--target', 'z', '--gate', 'abc'],
      { env, extendEnv: false, reject: false },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/gate/);
  });

  it('refuses a --depth that is not a whole number', async () => {
    const r = await execa(bin, ['explore', 'http://127.0.0.1:9/', '--depth', 'x'], {
      env,
      extendEnv: false,
      reject: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/depth/);
  });

  it('refuses --attach together with --profile, naming both flags', async () => {
    // one session cannot be both the attached chrome's own profile and the pack's own
    for (const args of [
      ['capture', '--pack', 'x', '--attach', 'http://127.0.0.1:9', '--profile'],
      ['explore', 'http://127.0.0.1:9/', '--attach', 'http://127.0.0.1:9', '--profile'],
      ['replay', 'signup', '--pack', 'x', '--attach', 'http://127.0.0.1:9', '--profile'],
    ]) {
      const r = await execa(bin, args, { env, extendEnv: false, reject: false });
      expect(r.exitCode, args[0]).not.toBe(0);
      expect(r.stderr, args[0]).toMatch(/--attach/);
      expect(r.stderr, args[0]).toMatch(/--profile/);
    }
  });

  it('refuses an empty --gate and an empty --depth, which Number() would read as 0', async () => {
    const gate = await execa(
      bin,
      ['verify', '--pack', 'x', '--unit', 'y', '--target', 'z', '--gate', ''],
      { env, extendEnv: false, reject: false },
    );
    expect(gate.exitCode).not.toBe(0);
    expect(gate.stderr).toMatch(/gate/);
    const depth = await execa(bin, ['explore', 'http://127.0.0.1:9/', '--depth', ''], {
      env,
      extendEnv: false,
      reject: false,
    });
    expect(depth.exitCode).not.toBe(0);
    expect(depth.stderr).toMatch(/depth/);
  });

  it('takes any gate Number reads as a fraction of 0 or more, exponents included', () => {
    expect(gateArg('0')).toBe(0);
    expect(gateArg('0.001')).toBe(0.001);
    // the stop hook passes its gate as String(gate), and String(1e-7) is '1e-7'
    expect(gateArg('1e-7')).toBe(1e-7);
    for (const bad of ['', '  ', 'abc', '-0.5', 'NaN', 'Infinity'])
      expect(() => gateArg(bad), bad).toThrow(/gate/);
  });

  it('takes either viewport name and refuses any other', () => {
    // the no-op negative: both names a pack captures at come back as they were typed
    expect(viewportArg('mobile')).toBe('mobile');
    expect(viewportArg('desktop')).toBe('desktop');
    for (const bad of ['tablet', 'Mobile', '', 'mobile,desktop'])
      expect(() => viewportArg(bad), bad).toThrow(/viewport must be one of mobile, desktop/);
  });

  it('takes a count of 1 or more and refuses anything else', () => {
    expect(positiveIntArg('3')).toBe(3);
    for (const bad of ['0', '-1', 'abc', '2.5', ''])
      expect(() => positiveIntArg(bad), bad).toThrow(/whole number/);
  });

  it('refuses a --parallel or --rounds that is not a count, before touching the pack', async () => {
    for (const args of [
      ['build', '--pack', 'x', '--parallel', '0'],
      ['build', '--pack', 'x', '--rounds', 'six'],
      ['build', '--pack', 'x', '--parallel', ''],
    ]) {
      const r = await execa(bin, args, { env, extendEnv: false, reject: false });
      expect(r.exitCode, args.join(' ')).not.toBe(0);
      expect(r.stderr, args.join(' ')).toMatch(/whole number of 1 or more/);
    }
  });

  it('takes a model alias for the workers, and another for the reviewer alone', async () => {
    const { stdout } = await execa(bin, ['build', '--help'], { env, extendEnv: false });
    expect(stdout).toMatch(/--model <name>/);
    expect(stdout).toMatch(/--reviewer-model <name>/);
  });

  it('resolves a path option against the cli cwd and leaves an absolute one alone', () => {
    // the no-op negative: an absolute path is already what the hooks and the worker need
    expect(absoluteArg('/packs/x')).toBe('/packs/x');
    // the hooks run with the rebuilt project as their cwd and the brief is read there too, so
    // a pack spelled the way the readme teaches has to be resolved here, once
    expect(absoluteArg('sites/x.com')).toBe(path.resolve('sites/x.com'));
    expect(absoluteArg('./builds/x.com/')).toBe(path.resolve('builds/x.com'));
  });

  it('resolves --claude only when it is a path, so a bare name stays a PATH lookup', () => {
    // the no-op negative: a bare name is looked up on the worker's PATH, wherever it runs
    expect(claudeArg('claude')).toBe('claude');
    // a relative one would be looked for under the project, which is the worker's cwd
    expect(claudeArg('./bin/claude')).toBe(path.resolve('bin/claude'));
    expect(claudeArg('test/helpers/fake-claude/claude')).toBe(
      path.resolve('test/helpers/fake-claude/claude'),
    );
    expect(claudeArg('/usr/local/bin/claude')).toBe('/usr/local/bin/claude');
  });

  it('lists the new commands', async () => {
    const { stdout } = await execa(bin, ['--help'], { env, extendEnv: false });
    // the command column, not the prose: 'report' appears in three descriptions already
    for (const c of ['scaffold', 'plan', 'build', 'report', 'hook', 'shot', 'browser', 'brand'])
      expect(stdout, c).toMatch(new RegExp(`^\\s+${c}\\b`, 'm'));
  });

  it('takes brand with a project and a brand file, and a pack or a target as options', async () => {
    const { stdout } = await execa(bin, ['brand', '--help'], { env, extendEnv: false });
    expect(stdout).toMatch(/--project <dir>/);
    expect(stdout).toMatch(/--brand <file>/);
    expect(stdout).toMatch(/--pack <dir>/);
    expect(stdout).toMatch(/--target <url>/);
    const r = await execa(bin, ['brand', '--project', 'x'], {
      env,
      extendEnv: false,
      reject: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/--brand/);
  });

  it('reads the pack a rebuild came from out of its package name, or asks for --pack', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-brand-pack-'));
    try {
      await fs.writeFile(path.join(dir, 'package.json'), '{ "name": "x.com-rebuild" }\n');
      expect(await defaultPackFor(dir)).toBe(path.resolve('sites', 'x.com'));
      await fs.writeFile(path.join(dir, 'package.json'), '{ "name": "something-else" }\n');
      await expect(defaultPackFor(dir)).rejects.toThrow(/pass --pack/);
      await fs.rm(path.join(dir, 'package.json'));
      await expect(defaultPackFor(dir)).rejects.toThrow(/pass --pack/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
