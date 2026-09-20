import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../helpers/serve';
import { acquireLock } from '../../src/orchestrate/lock';

const bin = path.resolve('bin/site');
// bin/site runs `node`, so the node running the tests has to be first on the child's PATH.
const env = { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` };

let server: Awaited<ReturnType<typeof serveStatic>>;

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
});
afterAll(async () => {
  await server.close();
});

describe('cli end to end', () => {
  it('explores, captures and verifies the fixture site through bin/site', async () => {
    const pack = await fs.mkdtemp(path.join(os.tmpdir(), 'site-pack-cli-'));

    const explore = await execa(bin, ['explore', `${server.url}/`, '--out', pack, '--depth', '1'], {
      env,
      reject: false,
    });
    expect(explore.exitCode, explore.stderr).toBe(0);
    expect(explore.stdout).toContain('9 planned');

    const capture = await execa(bin, ['capture', '--pack', pack, '--keep-frames'], {
      env,
      reject: false,
    });
    expect(capture.exitCode, capture.stderr).toBe(0);
    expect(capture.stdout.startsWith('captured 9, blocked 0')).toBe(true);
    // video and frames of the index at both viewports, frames kept by the flag; a state's
    // interaction is its own segment
    for (const vp of ['mobile', 'desktop']) {
      const vdir = path.join(pack, 'pages', 'index', vp);
      await expect(fs.stat(path.join(vdir, 'video.webm'))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(vdir, 'frames', 'load-0001.png'))).resolves.toBeTruthy();
    }
    await expect(
      fs.stat(
        path.join(
          pack,
          'pages',
          'index',
          'states',
          'modal-talk-to-us',
          'desktop',
          'frames',
          'prepare-0001.png',
        ),
      ),
    ).resolves.toBeTruthy();

    const verify = await execa(
      bin,
      ['verify', '--pack', pack, '--unit', 'page:index', '--target', server.url],
      { env, reject: false },
    );
    expect(verify.exitCode, verify.stderr).toBe(0);
    expect(verify.stdout).toContain('PASS');
    expect(verify.stdout.match(/pixel 0\.000%/g)?.length).toBe(2);

    const state = await execa(
      bin,
      ['verify', '--pack', pack, '--unit', 'state:index/modal-talk-to-us', '--target', server.url],
      { env, reject: false },
    );
    expect(state.exitCode, state.stderr).toBe(0);
    expect(state.stdout).toContain('PASS');
    expect(state.stdout.match(/pixel 0\.000%/g)?.length).toBe(2);

    // a flow: the steps file a recording would have written, its masked input answered
    const stepsFile = path.join(pack, 'steps', 'contact.json');
    await fs.mkdir(path.dirname(stepsFile), { recursive: true });
    const at = new Date().toISOString();
    await fs.writeFile(
      stepsFile,
      JSON.stringify(
        {
          flow: 'contact',
          start: `${server.url}/`,
          recordedAt: at,
          steps: [
            {
              n: 1,
              kind: 'click',
              target: {
                role: { role: 'button', name: 'Talk to us' },
                text: 'Talk to us',
                css: '#open-modal',
              },
              value: null,
              input: null,
              scroll: null,
              url: `${server.url}/`,
              at,
            },
            {
              n: 2,
              kind: 'input',
              target: { role: { role: 'textbox', name: 'Email' }, text: null, css: '#modal input' },
              value: null,
              input: 'email',
              scroll: null,
              url: `${server.url}/`,
              at,
            },
          ],
        },
        null,
        2,
      ),
    );
    const manifestFile = path.join(pack, 'manifest.json');
    const withFlow = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
    withFlow.flows.contact = { steps: [], inputs: { email: 'ada@example.com' } };
    await fs.writeFile(manifestFile, JSON.stringify(withFlow, null, 2));

    const replay = await execa(bin, ['replay', 'contact', '--pack', pack], { env, reject: false });
    expect(replay.exitCode, replay.stderr).toBe(0);
    expect(replay.stdout).toContain('contact: captured 2, blocked 0');
    // replay without the flag: the video stays, the frames do not
    const stepDir = path.join(pack, 'flows', 'contact', 'step-01-click-talk-to-us', 'desktop');
    await expect(fs.stat(path.join(stepDir, 'video.webm'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(stepDir, 'frames'))).rejects.toThrow();

    // replay with the flag: the step's own interaction segment stays on disk as frames
    const kept = await execa(bin, ['replay', 'contact', '--pack', pack, '--keep-frames'], {
      env,
      reject: false,
    });
    expect(kept.exitCode, kept.stderr).toBe(0);
    expect(kept.stdout).toContain('contact: captured 2, blocked 0');
    await expect(fs.stat(path.join(stepDir, 'frames', 'prepare-0001.png'))).resolves.toBeTruthy();

    // with --target replay reads the pack and writes nothing: it walks the rebuild and reports,
    // so it runs while a build holds the lock rather than being refused with it
    const held = await acquireLock(pack, 'a-build');
    let walked;
    try {
      walked = await execa(bin, ['replay', 'contact', '--pack', pack, '--target', server.url], {
        env,
        reject: false,
      });
    } finally {
      await held();
    }
    expect(walked.exitCode, walked.stderr).toBe(0);
    expect(walked.stderr).not.toContain('holds this pack');
    expect(walked.stdout.match(/PASS/g)?.length).toBe(2);

    const step = await execa(
      bin,
      [
        'verify',
        '--pack',
        pack,
        '--unit',
        'flow:contact/step-01-click-talk-to-us',
        '--target',
        server.url,
      ],
      { env, reject: false },
    );
    expect(step.exitCode, step.stderr).toBe(0);
    expect(step.stdout).toContain('PASS');

    const manifest = JSON.parse(await fs.readFile(path.join(pack, 'manifest.json'), 'utf8'));
    expect(manifest.units['page:index'].status).toBe('captured');
  }, 900_000);

  it('refuses to capture into a pack another run holds, and leaves the manifest untouched', async () => {
    // a capture while a build is working the pack is the natural thing to reach for when one
    // unit needs recapturing, and both sides rewrite the whole manifest from their own copy:
    // whichever saved last used to win, and the run's in-flight statuses, blocks and questions
    // went with it
    const pack = await fs.mkdtemp(path.join(os.tmpdir(), 'site-pack-lock-'));
    try {
      const explore = await execa(
        bin,
        ['explore', `${server.url}/`, '--out', pack, '--depth', '0'],
        { env, reject: false },
      );
      expect(explore.exitCode, explore.stderr).toBe(0);
      const manifestFile = path.join(pack, 'manifest.json');
      const before = await fs.readFile(manifestFile);
      const release = await acquireLock(pack, 'someone-else');
      try {
        // replay without --target captures the flow into the pack, so it is a writer too
        for (const args of [
          ['capture', '--pack', pack],
          ['replay', 'contact', '--pack', pack],
          ['record', 'contact', '--pack', pack],
        ]) {
          const r = await execa(bin, args, { env, reject: false });
          expect(r.exitCode, args.join(' ')).toBe(1);
          expect(r.stderr, args.join(' ')).toContain('holds this pack');
          expect(r.stderr, args.join(' ')).toContain('run someone-else');
        }
        expect(await fs.readFile(manifestFile)).toEqual(before);
        // a reader is not a writer: plan and report never wanted the lock
        const plan = await execa(bin, ['plan', '--pack', pack], { env, reject: false });
        expect(plan.exitCode, plan.stderr).toBe(0);
      } finally {
        await release();
      }
      // and with the lock gone the same command runs, and leaves no lock of its own behind
      const capture = await execa(bin, ['capture', '--pack', pack, '--unit', 'page:index'], {
        env,
        reject: false,
      });
      expect(capture.exitCode, capture.stderr).toBe(0);
      expect(capture.stdout).toContain('captured 1');
      await expect(fs.stat(path.join(pack, 'runs', '.lock'))).rejects.toThrow(/ENOENT/);
    } finally {
      await fs.rm(pack, { recursive: true, force: true });
    }
  }, 900_000);

  it('validates record arguments before opening a browser', async () => {
    const bad = await execa(bin, ['record', 'Sign Up', '--pack', 'x'], { env, reject: false });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toMatch(/flow name/);
    const noStart = await execa(
      bin,
      ['record', 'signup', '--pack', path.join(os.tmpdir(), 'site-no-such-pack')],
      { env, reject: false },
    );
    expect(noStart.exitCode).not.toBe(0);
    expect(noStart.stderr).toMatch(/--start/);
  });
});
