import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { serveStatic } from '../helpers/serve';
import { openSession, type Session } from '../../src/capture/session';
import { explore } from '../../src/capture/explore';
import { captureAll } from '../../src/capture/capture-all';
import { workerEnv } from '../../src/orchestrate/worker';
import { ERROR_CODES } from '../../src/pack/defaults';
import { loadManifest, readJson, saveManifest } from '../../src/pack/io';
import { unitIdForState } from '../../src/pack/ids';
import { PackPaths, UNIT_FILES } from '../../src/pack/paths';
import { SectionsFileSchema } from '../../src/pack/schemas';
import { shootUnit } from '../../src/verify/shot';

const bin = path.resolve('bin/site');
// bin/site runs `node`, so this node goes first on the child's PATH; workerEnv takes the
// session variables out, so the test runs the same from a terminal and from inside a session
const env = workerEnv({
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
});
const HERO = 'page:index#s02-hero-know-before-you-go';
let server: Awaited<ReturnType<typeof serveStatic>>;
let session: Session;
let root: string;
let work: string;

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  session = await openSession({});
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-pack-shot-'));
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'site-shot-'));
  await explore({ root, url: `${server.url}/`, depth: 0, scope: [], session, states: false });
  await captureAll({ root, session });
}, 600_000);
afterAll(async () => {
  await session.close();
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
});

describe('site shot', () => {
  it('shoots a section at both viewports the way verify reaches it: the full page and the crop', async () => {
    const out = path.join(work, 'hero');
    const r = await shootUnit({ root, unitId: HERO, target: server.url, session, outDir: out });
    expect(r.notes).toEqual([]);
    expect(r.files.map((f) => path.basename(f.file))).toEqual([
      'mobile.full.png',
      'mobile.s02-hero-know-before-you-go.png',
      'desktop.full.png',
      'desktop.s02-hero-know-before-you-go.png',
    ]);
    const m = await loadManifest(root);
    const sections = await readJson(
      SectionsFileSchema,
      path.join(new PackPaths(root).pageDir('index'), UNIT_FILES.sections),
    );
    const hero = sections.find((s) => s.id === 's02-hero-know-before-you-go')!;
    for (const f of r.files) {
      const png = PNG.sync.read(await fs.readFile(f.file));
      const scale = m.viewports[f.viewport].scale;
      if (f.box) {
        // against the fixture itself the crop is the source's own box, settled and frozen the
        // same way: the same height within a pixel or two, at the device scale
        expect(Math.abs(f.box.height - hero.bbox[f.viewport]!.height)).toBeLessThanOrEqual(2);
        expect(Math.abs(png.width - f.box.width * scale)).toBeLessThanOrEqual(2);
      } else {
        expect(png.width).toBe(m.viewports[f.viewport].width * scale);
        expect(png.height).toBeGreaterThan(m.viewports[f.viewport].height * scale);
      }
    }
  }, 300_000);

  it('shoots one viewport when asked, and a whole page without a crop', async () => {
    const out = path.join(work, 'page');
    const r = await shootUnit({
      root,
      unitId: 'page:index',
      target: server.url,
      session,
      outDir: out,
      viewports: ['mobile'],
    });
    expect(r.notes).toEqual([]);
    expect(r.files).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ viewport: 'mobile', box: null });
    expect(path.basename(r.files[0]!.file)).toBe('mobile.full.png');
  }, 300_000);

  it('notes the viewport a state was never reached at, and shoots the one it was', async () => {
    // a state its discovery pass reached at one viewport only (a hamburger menu at phone
    // width, a nav hover at desktop) has no source shot at the other, so there is nothing to
    // shoot ours against there: the note is what tells the worker why one png is missing
    const manifest = await loadManifest(root);
    const stateId = unitIdForState('index', 'modal-talk-to-us');
    manifest.units[stateId] = {
      kind: 'state',
      status: 'planned',
      url: manifest.units['page:index']!.url,
      dependsOn: ['page:index'],
      rounds: 0,
      updatedAt: new Date().toISOString(),
      actions: [
        {
          kind: 'click',
          target: { role: { role: 'button', name: 'Talk to us' }, text: 'Talk to us', css: '' },
          value: null,
          input: null,
          scroll: null,
        },
      ],
      reachable: ['desktop'],
    };
    await saveManifest(root, manifest);
    const out = path.join(work, 'state');
    const r = await shootUnit({ root, unitId: stateId, target: server.url, session, outDir: out });
    expect(r.notes).toEqual(['mobile: the source has no capture at this viewport']);
    expect(r.files.map((f) => path.basename(f.file))).toEqual(['desktop.full.png']);
    expect(r.files[0]).toMatchObject({ viewport: 'desktop', box: null });
    await expect(fs.stat(path.join(out, 'mobile.full.png'))).rejects.toThrow(/ENOENT/);
  }, 300_000);

  it('notes a section whose data-section and whose selector both miss in the rebuild', async () => {
    // the rebuild answered, and the page it answered with does not carry the section at all:
    // the full page is still shot (a worker can look at what it did build) and the note names
    // both ways of finding it, so a missing `data-section` reads as what it is
    const plain = path.join(work, 'plain');
    await fs.mkdir(plain, { recursive: true });
    await fs.writeFile(
      path.join(plain, 'index.html'),
      '<!doctype html><html><head><title>Plain</title></head><body><main><p>nothing built yet</p></main></body></html>\n',
    );
    const other = await serveStatic(plain);
    try {
      const out = path.join(work, 'missing-section');
      const r = await shootUnit({ root, unitId: HERO, target: other.url, session, outDir: out });
      expect(r.files.map((f) => path.basename(f.file))).toEqual([
        'mobile.full.png',
        'desktop.full.png',
      ]);
      expect(r.files.every((f) => f.box === null)).toBe(true);
      expect(r.notes).toHaveLength(2);
      for (const [i, vp] of ['mobile', 'desktop'].entries()) {
        expect(r.notes[i]).toContain(`${vp}: no element carries data-section=`);
        expect(r.notes[i]).toContain('s02-hero-know-before-you-go');
      }
    } finally {
      await other.close();
    }
  }, 300_000);

  it("refuses a target that answers an error status, with the capture pipeline's own code", async () => {
    // a second static server over a dir with no index.html: every request 404s, so the shot
    // would otherwise be a png of the rebuild's error page
    const empty = await serveStatic(path.join(work, 'nothing'));
    try {
      const err = (await shootUnit({
        root,
        unitId: 'page:index',
        target: empty.url,
        session,
        outDir: path.join(work, 'gone'),
      }).catch((e: unknown) => e)) as Error & { code?: string };
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(ERROR_CODES.httpError);
      expect(err.message).toMatch(/answered http 404/);
    } finally {
      await empty.close();
    }
  }, 300_000);

  it('runs through bin/site, prints the files it wrote, and refuses a viewport it does not know', async () => {
    const out = path.join(work, 'cli');
    const r = await execa(
      bin,
      [
        'shot',
        '--pack',
        root,
        '--unit',
        HERO,
        '--target',
        server.url,
        '--out',
        out,
        '--viewport',
        'desktop',
      ],
      { env, extendEnv: false, reject: false },
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines[0]).toBe(path.join(out, 'desktop.full.png'));
    expect(
      lines[1]!.startsWith(`${path.join(out, 'desktop.s02-hero-know-before-you-go.png')}  (box x `),
    ).toBe(true);
    const bad = await execa(
      bin,
      [
        'shot',
        '--pack',
        root,
        '--unit',
        HERO,
        '--target',
        server.url,
        '--out',
        out,
        '--viewport',
        'tablet',
      ],
      { env, extendEnv: false, reject: false },
    );
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toMatch(/viewport must be one of mobile, desktop/);
  }, 300_000);
});
