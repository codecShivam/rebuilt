import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../helpers/serve';
import { openSession, type Session } from '../../src/capture/session';
import { explore } from '../../src/capture/explore';
import { captureAll } from '../../src/capture/capture-all';
import { verifyUnit } from '../../src/verify/verify';
import { oursPngName } from '../../src/verify/verify';
import { captureOurs } from '../../src/verify/capture-ours';
import { loadManifest, readJson, saveManifest } from '../../src/pack/io';
import { PackPaths, UNIT_FILES } from '../../src/pack/paths';
import {
  AnimationsFileSchema,
  PageMetaSchema,
  StylesFileSchema,
  VerifyResultSchema,
  type PageMeta,
} from '../../src/pack/schemas';
import { readPng } from '../../src/pack/image';
import { DEFAULT_VIEWPORTS, PAGE_SHEET_PANEL_WIDTH } from '../../src/pack/defaults';

let server: Awaited<ReturnType<typeof serveStatic>>;
let mutated: Awaited<ReturnType<typeof serveStatic>>;
let session: Session;
let root: string;

const MENU =
  'body>header:nth-of-type(1)>nav:nth-of-type(1)>ul:nth-of-type(1)>li:nth-of-type(1)>ul:nth-of-type(1)';
const MODAL_BOX = 'body>div:nth-of-type(1)>div:nth-of-type(1)';

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  mutated = await serveStatic(path.resolve('test/fixtures/site-mutated'));
  session = await openSession({});
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-pack-'));
  // the index with its six states, and the app page (no states) for the null-box section
  await explore({ root, url: `${server.url}/`, depth: 0, scope: [], session });
  await explore({ root, url: `${server.url}/app.html`, depth: 0, scope: [], session });
  await captureAll({ root, session });
}, 600_000);
afterAll(async () => {
  await session.close();
  await server.close();
  await mutated.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('verifyUnit', () => {
  it('passes the fixture against itself with a zero score', async () => {
    const r = await verifyUnit({ root, unitId: 'page:index', target: server.url, session });
    expect(r.verdict).toBe('pass');
    expect(r.pixel.desktop!.score).toBe(0);
    expect(r.pixel.mobile!.score).toBe(0);
    expect(r.styles).toEqual([]);
    expect(r.animations).toEqual([]);
    expect(r.structure).toEqual([]);
    expect(r.missing).toEqual([]);
    await expect(fs.stat(r.pixel.desktop!.contactSheet)).resolves.toBeTruthy();
    // the whole-page sheet is scaled to a capped panel width; the motion report compared the
    // load at both viewports, splitting the source's frames from its video (none were kept)
    const sheet = await readPng(r.pixel.desktop!.contactSheet);
    expect(sheet.width).toBeLessThanOrEqual(PAGE_SHEET_PANEL_WIDTH * 3 + 16);
    expect(r.frames.map((f) => [f.viewport, f.segment])).toEqual([
      ['mobile', 'load'],
      ['desktop', 'load'],
    ]);
    for (const f of r.frames) {
      expect(f.compared).toBeGreaterThan(0);
      expect(f.strip).not.toBeNull();
      await expect(fs.stat(f.strip!)).resolves.toBeTruthy();
      // a loose sanity bound, not a gate: a one-frame shift of the fixture's 300 ms fade moves
      // maxScore a long way and the mean hardly at all, so this catches a comparison that is
      // looking at the wrong frames without measuring the scheduler
      expect(f.meanScore, `${f.viewport} ${f.segment}`).toBeLessThan(0.1);
    }
    // the property the milestone 3 fix established is that the load segment ends where settle
    // begins, and that is deterministic. a score bound over it is not: the fixture's one-shot
    // 300 ms fade lands on different frame indices between two recordings (spec section 6),
    // so the number measured scheduler jitter and moved with the load on the machine.
    const frame = 1 / 30;
    const endsAtSettle = (meta: PageMeta, where: string) => {
      for (const vp of ['mobile', 'desktop'] as const) {
        const motion = meta.motion[vp];
        expect(motion, `${where} ${vp}`).not.toBeNull();
        expect(motion!.settleAt, `${where} ${vp}`).not.toBeNull();
        expect(motion!.segments[0]!.name, `${where} ${vp}`).toBe('load');
        expect(
          Math.abs(motion!.segments[0]!.seconds - motion!.settleAt! / 1000),
          `${where} ${vp}`,
        ).toBeLessThanOrEqual(frame);
      }
    };
    endsAtSettle(
      await readJson(PageMetaSchema, path.join(root, 'pages', 'index', UNIT_FILES.meta)),
      'source',
    );
    // and the same on the side verify captures for itself, which is where the comparison's
    // other half comes from
    const ours = await captureOurs({
      root,
      manifest: await loadManifest(root),
      unitId: 'page:index',
      target: server.url,
      session,
    });
    try {
      endsAtSettle(ours.summary.meta, 'ours');
    } finally {
      await ours.cleanup();
    }
  }, 600_000);

  it('writes the diff, sheet, strip and ours paths into verify.json', async () => {
    const r = await verifyUnit({ root, unitId: 'page:index', target: server.url, session });
    expect(r.verdict).toBe('pass');
    const file = path.join(root, 'runs', 'verify', 'page_index', 'verify.json');
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as { artefacts: string[] };
    // two diffs, two sheets, two strips, and ours' full page at both viewports: what the
    // reviewer looks at after the temp pack is gone
    expect(onDisk.artefacts).toHaveLength(8);
    for (const a of onDisk.artefacts) expect(a).toMatch(/\.(diff|sheet|strip|full)\.png$/);
    for (const vp of ['mobile', 'desktop'] as const) {
      const ours = path.join(root, 'runs', 'verify', 'page_index', oursPngName(vp, 'full'));
      expect(onDisk.artefacts).toContain(ours);
      const png = await readPng(ours);
      expect(png.width).toBe(DEFAULT_VIEWPORTS[vp].width * DEFAULT_VIEWPORTS[vp].scale);
    }
    // the returned object names verify.json itself as well; the file cannot name itself
    // before it is written.
    expect(r.artefacts).toEqual([...onDisk.artefacts, file]);
  });

  it('passes a section unit against itself', async () => {
    const r = await verifyUnit({
      root,
      unitId: 'page:index#s03-features-everything-you-need',
      target: server.url,
      session,
    });
    expect(r.verdict).toBe('pass');
    expect(r.pixel.desktop!.score).toBe(0);
    // a section sheet stays full size (the features crop is 1440 css px wide at scale 2)
    const sheet = await readPng(r.pixel.desktop!.contactSheet);
    expect(sheet.width).toBeGreaterThan(PAGE_SHEET_PANEL_WIDTH * 3 + 16);
    expect(r.frames).toEqual([]);
    // ours' crop of the section, named by the source's id, sits next to the diff
    const crop = path.join(
      root,
      'runs',
      'verify',
      'page_index_s03-features-everything-you-need',
      oursPngName('desktop', 's03-features-everything-you-need'),
    );
    expect(r.artefacts).toContain(crop);
    await expect(fs.stat(crop)).resolves.toBeTruthy();
  });

  it("clears its own artefacts from an out dir and never the pack's pngs", async () => {
    // --out names any dir the caller likes, the round's rule admits one, and the pack's own
    // pngs sit under names of their own: a verify that cleared every png in the dir it was
    // pointed at would take the capture with it
    const out = path.join(root, 'runs', 'verify', 'out-dir-guard');
    await fs.mkdir(out, { recursive: true });
    const packNames = ['full.png', 'section-s03-features-everything-you-need.png', 'frames'];
    const stale = 'ours.desktop.s99-from-an-older-run.png';
    await fs.mkdir(path.join(out, 'frames'), { recursive: true });
    await fs.writeFile(path.join(out, 'frames', 'f0001.png'), 'a frame');
    for (const name of ['full.png', 'section-s03-features-everything-you-need.png', stale]) {
      await fs.writeFile(path.join(out, name), 'not a png');
    }
    await fs.writeFile(path.join(out, oursPngName('desktop', 'full')), 'not a png');
    const r = await verifyUnit({
      root,
      unitId: 'page:index#s03-features-everything-you-need',
      target: server.url,
      session,
      outDir: out,
    });
    expect(r.verdict).toBe('pass');
    // the pack's names are untouched, whole and still where they were
    expect(await fs.readFile(path.join(out, 'full.png'), 'utf8')).toBe('not a png');
    expect(
      await fs.readFile(path.join(out, 'section-s03-features-everything-you-need.png'), 'utf8'),
    ).toBe('not a png');
    expect(await fs.readFile(path.join(out, 'frames', 'f0001.png'), 'utf8')).toBe('a frame');
    expect((await fs.readdir(out)).filter((n) => packNames.includes(n)).sort()).toEqual(
      [...packNames].sort(),
    );
    // its own are gone: an artefact of a run whose verify.json no longer names it must not
    // outlive the result, and the one it rewrites is its own again
    await expect(fs.stat(path.join(out, stale))).rejects.toThrow(/ENOENT/);
    expect(await fs.readFile(path.join(out, oursPngName('desktop', 'full')), 'utf8')).not.toBe(
      'not a png',
    );
  }, 600_000);

  it('passes the hero section, whose crop holds the masked counter', async () => {
    // the live counter sits inside the hero, so a mask shifted by the crop offset would
    // leave a changing digit inside the compared region and score above zero.
    const r = await verifyUnit({
      root,
      unitId: 'page:index#s02-hero-know-before-you-go',
      target: server.url,
      session,
    });
    expect(r.verdict).toBe('pass');
    expect(r.pixel.desktop!.score).toBe(0);
    expect(r.pixel.mobile!.score).toBe(0);
  });

  it('names the colour, the padding and the dropped item on the mutated site', async () => {
    const r = await verifyUnit({ root, unitId: 'page:index', target: mutated.url, session });
    expect(r.verdict).toBe('fail');
    expect(r.pixel.desktop!.score).toBeGreaterThan(0.001);
    const colour = r.styles.find(
      (s) => s.property === 'background-color' && s.expected === 'rgb(37, 99, 235)',
    );
    expect(colour?.actual).toBe('rgb(30, 64, 175)');
    const padding = r.styles.find((s) => s.property === 'padding-left' && s.expected === '24px');
    expect(padding?.actual).toBe('32px');
    expect(
      r.structure.some((f) => f.kind === 'item' && f.expected.includes('Private by design')),
    ).toBe(true);
    // the easing is a computed animation property: the animations gate owns it now, the
    // style diff does not report it a second time
    const easing = r.animations.find((a) => a.property === 'animation-timing-function');
    expect(easing).toMatchObject({ expected: 'ease-in-out', actual: 'linear', viewport: 'mobile' });
    expect(r.animations.filter((a) => a.property.startsWith('keyframes:'))).toEqual([]);
    expect(r.styles.some((s) => s.property.startsWith('animation-'))).toBe(false);
    // nothing else drifted: every remaining style finding is either one of the four direct
    // mutations (colour, padding, easing, and the dropped card itself), or a deterministic
    // cascade of the colour/padding/drop mutations elsewhere on the page:
    //  - dropping the third (mobile-stacked) card shortens main/the features section/the
    //    cards list on mobile (the desktop 3-column grid still fits 2 items in one row, so
    //    it does not move there)
    //  - the .card padding-left increase (24px -> 32px) narrows every card's content box,
    //    so the remaining cards' h3/p report an 8px narrower width on both viewports
    const CASCADE_ANCESTORS = new Set([
      'body>main:nth-of-type(1)',
      'body>main:nth-of-type(1)>section:nth-of-type(2)',
      'body>main:nth-of-type(1)>section:nth-of-type(2)>ul:nth-of-type(1)',
    ]);
    const unexpected = r.styles.filter((s) => {
      if (['background-color', 'padding-left'].includes(s.property)) return false;
      if (s.path.includes('li:nth-of-type(3)')) return false;
      if (CASCADE_ANCESTORS.has(s.path) && ['height', 'grid-template-rows'].includes(s.property))
        return false;
      if (
        s.property === 'width' &&
        /ul:nth-of-type\(1\)>li:nth-of-type\(\d+\)>(h3|p):nth-of-type\(1\)$/.test(s.path)
      )
        return false;
      return true;
    });
    expect(unexpected.map((u) => `${u.path} ${u.property}`)).toEqual([]);
  });

  it('captured every discovered state of the index into its own dir', async () => {
    const m = await loadManifest(root);
    const states = Object.keys(m.units)
      .filter((id) => id.startsWith('state:index/'))
      .sort();
    expect(states).toHaveLength(7);
    for (const id of states) expect(m.units[id]!.status, id).toBe('captured');
    const pack = new PackPaths(root);
    const drawer = pack.stateDir('index', 'menu-menu-open');
    expect(m.units['state:index/menu-menu-open']!.reachable).toEqual(['mobile']);
    await expect(fs.stat(path.join(drawer, 'mobile', UNIT_FILES.full))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(drawer, 'desktop'))).rejects.toThrow();
    const hoverDir = pack.stateDir('index', 'hover-nav-products');
    const hover = await readJson(StylesFileSchema, path.join(hoverDir, UNIT_FILES.styles));
    expect(hover.desktop[MENU]?.styles['display']).toBe('block');
    const meta = await readJson(PageMetaSchema, path.join(hoverDir, UNIT_FILES.meta));
    expect(meta.reachedBy).toBe('replay');
    const page = await readJson(
      StylesFileSchema,
      path.join(pack.pageDir('index'), UNIT_FILES.styles),
    );
    expect(page.desktop[MENU]).toBeUndefined();
    const modal = await readJson(
      StylesFileSchema,
      path.join(pack.stateDir('index', 'modal-talk-to-us'), UNIT_FILES.styles),
    );
    expect(modal.desktop[MODAL_BOX]?.tag).toBe('div');
    expect(modal.mobile[MODAL_BOX]?.tag).toBe('div');
  });

  it('verifies a state against itself with a zero score', async () => {
    const r = await verifyUnit({
      root,
      unitId: 'state:index/modal-talk-to-us',
      target: server.url,
      session,
    });
    expect(r.verdict).toBe('pass');
    expect(r.pixel.desktop!.score).toBe(0);
    expect(r.pixel.mobile!.score).toBe(0);
    expect(r.missing).toEqual([]);
    await expect(
      fs.stat(path.join(root, 'runs', 'verify', 'state_index_modal-talk-to-us', 'verify.json')),
    ).resolves.toBeTruthy();
    // a state's interaction was recorded on both sides and compared as its own segment
    expect(r.frames.filter((f) => f.segment === 'prepare').map((f) => f.viewport)).toEqual([
      'mobile',
      'desktop',
    ]);
    // the modal is position: fixed; inset: 0 over the live counter. a mask that took the
    // topmost element would cover the viewport, and the zero score above would mean nothing
    const meta = await readJson(
      PageMetaSchema,
      path.join(new PackPaths(root).stateDir('index', 'modal-talk-to-us'), UNIT_FILES.meta),
    );
    for (const vp of ['mobile', 'desktop'] as const) {
      expect(meta.masks[vp].length, vp).toBeGreaterThan(0);
      for (const m of meta.masks[vp])
        expect(m.width, `${vp} width`).toBeLessThan(DEFAULT_VIEWPORTS[vp].width / 4);
    }
  });

  it('verifies a hover state against itself with a zero desktop score', async () => {
    // a hover is held by the pointer rather than by the dom, so its shot is the one most
    // likely to drift between two walks of the same page
    const r = await verifyUnit({
      root,
      unitId: 'state:index/hover-nav-products',
      target: server.url,
      session,
    });
    expect(r.pixel.desktop!.score).toBe(0);
    expect(r.missing).toEqual([]);
    expect(r.verdict).toBe('pass');
  }, 300_000);

  it('verifies a mobile-only state against itself and skips the viewport the source never reached', async () => {
    const r = await verifyUnit({
      root,
      unitId: 'state:index/menu-menu-open',
      target: server.url,
      session,
    });
    expect(r.verdict).toBe('pass');
    expect(r.pixel.mobile!.score).toBe(0);
    expect(r.pixel.desktop).toBeNull();
    expect(r.missing).toEqual([]);
  }, 300_000);

  it('reports one diff and one sheet for a section that has no mobile box, plus ours', async () => {
    const r = await verifyUnit({
      root,
      unitId: 'page:app#s04-section-only-on-wide-screens',
      target: server.url,
      session,
    });
    expect(r.verdict).toBe('pass');
    expect(r.pixel.mobile).toBeNull();
    expect(r.pixel.desktop!.score).toBe(0);
    const file = path.join(
      root,
      'runs',
      'verify',
      'page_app_s04-section-only-on-wide-screens',
      'verify.json',
    );
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8')) as { artefacts: string[] };
    // the desktop diff and sheet, ours' full page at both viewports (the page exists at
    // mobile, the section does not), and ours' desktop crop
    expect(onDisk.artefacts.filter((a) => /\.(diff|sheet)\.png$/.test(a))).toHaveLength(2);
    expect(onDisk.artefacts.filter((a) => a.endsWith('.full.png'))).toHaveLength(2);
    expect(
      onDisk.artefacts.filter((a) => a.endsWith('.s04-section-only-on-wide-screens.png')),
    ).toHaveLength(1);
    expect(r.artefacts).toEqual([...onDisk.artefacts, file]);
  });

  it('fails a rebuild that cannot reach the state at a viewport the source has', async () => {
    // the rebuild hides the menu trigger below 600px, so our walk reaches the state at
    // desktop only. the source has both shots: the missing mobile one is a failure, not a
    // viewport to skip.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-narrow-'));
    try {
      await fs.cp(path.resolve('test/fixtures/site'), dir, { recursive: true });
      await fs.appendFile(
        path.join(dir, 'styles.css'),
        '\n@media (max-width: 600px) { .has-menu { display: none; } }\n',
      );
      const narrow = await serveStatic(dir);
      try {
        const r = await verifyUnit({
          root,
          unitId: 'state:index/menu-products-open',
          target: narrow.url,
          session,
        });
        expect(r.verdict).toBe('fail');
        expect(r.missing).toContain('mobile/full.png');
        expect(r.pixel.mobile).toBeNull();
        expect(r.pixel.desktop).not.toBeNull();
        expect(r.heightDelta.mobile).toBeNull();
      } finally {
        await narrow.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it('writes a failed verify.json instead of throwing when the target is unreachable, and leaves no temp pack', async () => {
    const tmp = async (prefix: string) =>
      (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith(prefix)).length;
    const before = await tmp('site-ours-');
    const framesBefore = await tmp('site-frames-');
    // the two passing runs above wrote their diffs, sheets, strips and ours shots into this
    // same outDir: `site verify` reuses runs/verify/<unit> across calls, and the stop hook
    // reuses verify-hook across a round's holds
    const outDir = path.join(root, 'runs', 'verify', 'page_index');
    expect((await fs.readdir(outDir)).filter((n) => n.endsWith('.png')).length).toBeGreaterThan(0);
    // the orchestrator and the stop hook read the verdict from the file: a dead dev server is
    // a failed verify with the reason, not an exception that leaves no file behind
    const r = await verifyUnit({
      root,
      unitId: 'page:index',
      target: 'http://127.0.0.1:9',
      session,
    });
    expect(r.verdict).toBe('fail');
    expect(r.missing).toHaveLength(1);
    expect(r.missing[0]).toMatch(/^ours: navigation_failed: /);
    expect(r.pixel).toEqual({ mobile: null, desktop: null });
    expect(r.styles).toEqual([]);
    const file = path.join(outDir, 'verify.json');
    expect(r.artefacts).toEqual([file]);
    expect((await readJson(VerifyResultSchema, file)).verdict).toBe('fail');
    // this result names no image, so no image from an earlier run may be lying beside it
    expect((await fs.readdir(outDir)).filter((n) => n.endsWith('.png'))).toEqual([]);
    expect(await tmp('site-ours-')).toBe(before);
    // the frames scratch is taken before the capture and removed on the way out of it too
    expect(await tmp('site-frames-')).toBe(framesBefore);
  });

  it('still throws on a bug, so a broken pack is never a quiet fail', async () => {
    await expect(
      verifyUnit({ root, unitId: 'page:index#s99-nope', target: server.url, session }),
    ).rejects.toThrow(/section s99-nope not in pack/);
  });

  it('fails on keyframes and on a dropped animation that the pixels cannot see', async () => {
    // the badge is parked at time zero and the fade-in is finished before every shot, so a
    // changed pulse keyframe and a removed fade-in leave the stills identical: only the
    // animations gate can name them
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-anim-mut-'));
    try {
      await fs.cp(path.resolve('test/fixtures/site'), dir, { recursive: true });
      const css = await fs.readFile(path.join(dir, 'styles.css'), 'utf8');
      await fs.writeFile(
        path.join(dir, 'styles.css'),
        css
          .replace('50% { transform: scale(1.08); }', '50% { transform: scale(1.2); }')
          .replace('animation: fadeIn 300ms ease-out forwards;', ''),
      );
      const changed = await serveStatic(dir);
      try {
        const r = await verifyUnit({ root, unitId: 'page:index', target: changed.url, session });
        expect(r.verdict).toBe('fail');
        expect(r.pixel.desktop!.score).toBe(0);
        const keyframes = r.animations.filter((a) => a.property === 'keyframes:pulse');
        expect(keyframes.map((a) => a.viewport).sort()).toEqual(['desktop', 'mobile']);
        expect(keyframes[0]!.expected).toContain('scale(1.08)');
        expect(keyframes[0]!.actual).toContain('scale(1.2)');
        const dropped = r.animations.find(
          (a) => a.property === 'animation-name' && a.viewport === 'desktop',
        );
        expect(dropped).toMatchObject({ expected: 'fadeIn', actual: 'none' });
        expect(r.styles).toEqual([]);
      } finally {
        await changed.close();
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('keyframes only a stylesheet body could read', () => {
  it('verifies a cross-origin rule against a same-origin rebuild with no animation findings', async () => {
    // the source's rule is parsed out of a captured body (the page may not read the sheet);
    // the rebuild's comes from its own cssom. the two are only comparable because the capture
    // canonicalises the parsed stops through the page.
    const css =
      '@keyframes probe { 0% { opacity: .5; transform: translateY(0); margin: 0; ' +
      'background-position: 0 0; } 100% { opacity: 1; transform: translateY(10px); ' +
      'margin: 10px; background-position: 10px 10px; } }\n' +
      '.probe { animation: probe 2s linear infinite; }\n';
    const markup = (href: string) =>
      '<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Probe</title>' +
      `<link rel="stylesheet" href="${href}" /></head>` +
      '<body><main><section style="height:200px"><h1>Probe</h1>' +
      '<p class="probe">animated</p></section></main></body></html>';
    const dirs: string[] = [];
    const mk = async (prefix: string) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    };
    const sheetDir = await mk('site-kf-sheet-');
    await fs.writeFile(path.join(sheetDir, 'kf.css'), css);
    const sheets = await serveStatic(sheetDir);
    const farDir = await mk('site-kf-far-');
    await fs.writeFile(path.join(farDir, 'index.html'), markup(`${sheets.url}/kf.css`));
    const far = await serveStatic(farDir);
    const nearDir = await mk('site-kf-near-');
    await fs.writeFile(path.join(nearDir, 'kf.css'), css);
    await fs.writeFile(path.join(nearDir, 'index.html'), markup('/kf.css'));
    const near = await serveStatic(nearDir);
    const packRoot = await mk('site-pack-kf-');
    try {
      await explore({
        root: packRoot,
        url: `${far.url}/`,
        depth: 0,
        scope: [],
        session,
        states: false,
      });
      await captureAll({ root: packRoot, session });
      const animations = await readJson(
        AnimationsFileSchema,
        path.join(new PackPaths(packRoot).pageDir('index'), UNIT_FILES.animations),
      );
      expect(animations.keyframes['probe']!.from).toBe('stylesheet');
      const r = await verifyUnit({
        root: packRoot,
        unitId: 'page:index',
        target: near.url,
        session,
      });
      expect(r.animations).toEqual([]);
    } finally {
      await near.close();
      await far.close();
      await sheets.close();
      await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
    }
  }, 300_000);
});

describe('captureAll and a state whose trigger vanished', () => {
  it('blocks the unreachable state instead of aborting the whole run', async () => {
    // a hand-edited manifest stands in for a state whose trigger disappeared since explore
    // ran (or a challenge page, or a flow input nobody filled in): captureAll must degrade
    // it like a blocked page, not let a plain, code-less error kill every remaining unit.
    const ghostRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'site-pack-ghost-'));
    try {
      await explore({ root: ghostRoot, url: `${server.url}/`, depth: 0, scope: [], session });
      const manifest = await loadManifest(ghostRoot);
      manifest.units['state:index/ghost'] = {
        kind: 'state',
        status: 'planned',
        url: `${server.url}/`,
        dependsOn: ['page:index'],
        rounds: 0,
        updatedAt: new Date().toISOString(),
        actions: [
          {
            kind: 'click',
            target: {
              role: { role: 'button', name: 'Does Not Exist' },
              text: 'Does Not Exist',
              css: '#nope',
            },
            value: null,
            input: null,
            scroll: null,
          },
        ],
      };
      await saveManifest(ghostRoot, manifest);

      const result = await captureAll({ root: ghostRoot, session });
      expect(result.blocked).toContain('state:index/ghost');
      // page:index and its real states captured fine in the same run
      expect(result.captured.length).toBeGreaterThan(0);

      const after = await loadManifest(ghostRoot);
      const ghost = after.units['state:index/ghost']!;
      expect(ghost.status).toBe('blocked');
      expect(ghost.blockedReason).toBe('unreachable');
      expect(ghost.question).toContain('state:index/ghost');
    } finally {
      await fs.rm(ghostRoot, { recursive: true, force: true });
    }
  }, 300_000);
});
