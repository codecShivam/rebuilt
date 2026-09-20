import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { serveStatic } from '../helpers/serve';
import { openPage, openSession, type Session } from '../../src/capture/session';
import { capturePageUnit, resetFfmpegWarning } from '../../src/capture/pipeline';
import { freezeAnimations } from '../../src/capture/freeze';
import { PackPaths, UNIT_FILES } from '../../src/pack/paths';
import { DEFAULT_VIEWPORTS, ERROR_CODES, MASK_CELL, MASK_PAD } from '../../src/pack/defaults';
import { explore } from '../../src/capture/explore';
import { captureAll } from '../../src/capture/capture-all';
import { loadManifest, readJson, saveManifest } from '../../src/pack/io';
import {
  AnimationsFileSchema,
  SectionsFileSchema,
  StylesFileSchema,
  PageMetaSchema,
  AssetIndexSchema,
  TextFileSchema,
} from '../../src/pack/schemas';
import { padRect, readPng } from '../../src/pack/image';

let server: Awaited<ReturnType<typeof serveStatic>>;
let session: Session;
let root: string;
const tmpDirs: string[] = [];

/** a temp dir that afterAll removes. */
async function tmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  session = await openSession({});
  root = await tmp('site-pack-');
});
// the note a failed split prints is printed once per run, so a test that expects the warning
// must not depend on whether an earlier test already spent it
beforeEach(() => {
  resetFfmpegWarning();
});
afterAll(async () => {
  await session.close();
  await server.close();
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

/** a throwaway copy of the fixture site, mutated in place, served from its own port. */
async function fixtureCopy(mutate: (dir: string) => Promise<void>): Promise<string> {
  const dir = await tmp('site-fixture-');
  await fs.cp(path.resolve('test/fixtures/site'), dir, { recursive: true });
  await mutate(dir);
  return dir;
}

describe('capturePageUnit', () => {
  it('captures the fixture index into a complete page dir', async () => {
    const pack = new PackPaths(root);
    const summary = await capturePageUnit({
      pack,
      unitId: 'page:index',
      url: `${server.url}/`,
      viewports: [DEFAULT_VIEWPORTS.mobile, DEFAULT_VIEWPORTS.desktop],
      session,
      motion: { fps: 30, keepFrames: false },
    });
    const dir = summary.unitDir;
    expect(dir).toBe(pack.pageDir('index'));
    for (const f of [
      UNIT_FILES.meta,
      UNIT_FILES.sections,
      UNIT_FILES.text,
      UNIT_FILES.dom,
      UNIT_FILES.styles,
      UNIT_FILES.animations,
      UNIT_FILES.assetsIndex,
      UNIT_FILES.snapshot,
      'desktop/full.png',
      'mobile/full.png',
    ]) {
      await expect(fs.stat(path.join(dir, f)), f).resolves.toBeTruthy();
    }
    const sections = await readJson(SectionsFileSchema, path.join(dir, UNIT_FILES.sections));
    expect(sections.map((s) => s.role)).toEqual([
      'header',
      'hero',
      'features',
      'faq',
      'cta',
      'footer',
    ]);
    expect(sections[1]!.id).toBe('s02-hero-know-before-you-go');
    expect(sections[1]!.bbox.desktop).not.toBeNull();
    expect(sections[1]!.bbox.mobile).not.toBeNull();
    for (const s of sections) {
      await expect(
        fs.stat(path.join(dir, 'desktop', UNIT_FILES.section(s.id))),
      ).resolves.toBeTruthy();
      await expect(
        fs.stat(path.join(dir, 'mobile', UNIT_FILES.section(s.id))),
      ).resolves.toBeTruthy();
    }
    const crop = await readPng(path.join(dir, 'desktop', UNIT_FILES.section(sections[1]!.id)));
    expect(crop.width).toBe(Math.round(sections[1]!.bbox.desktop!.width * 2));

    const styles = await readJson(StylesFileSchema, path.join(dir, UNIT_FILES.styles));
    const h1 = Object.values(styles.desktop).find((e) => e.tag === 'h1');
    expect(h1?.styles['font-size']).toBe('48px');
    const h1m = Object.values(styles.mobile).find((e) => e.tag === 'h1');
    expect(h1m?.styles['font-size']).toBe('32px');
    // the hero h1 fades in over 300ms and fills forwards; the capture finishes it rather
    // than rewinding it, so the pack holds the page with its hero visible.
    expect(h1?.styles['opacity']).toBe('1');
    expect(h1m?.styles['opacity']).toBe('1');

    const meta = await readJson(PageMetaSchema, path.join(dir, UNIT_FILES.meta));
    expect(meta.title).toBe('Fixture Co');
    // both faces load (the body is 400, the logo and headings are 700), and each maps to its
    // file through @font-face: the hashed 700 file too, which no filename heuristic could name
    const faces = meta.fonts.filter((f) => f.family === 'Fixture');
    expect(faces.map((f) => f.weight).sort()).toEqual(['400', '700']);
    expect(faces.find((f) => f.weight === '400')?.file).toMatch(/Fixture-Regular\.woff2$/);
    expect(faces.find((f) => f.weight === '700')?.file).toMatch(/a1b2c3d4e5\.woff2$/);
    expect(faces.find((f) => f.weight === '700')?.url).toBe(`${server.url}/fonts/a1b2c3d4e5.woff2`);
    // the load was recorded and split; frames are gone by default, the video stays
    expect(meta.motion.desktop).toMatchObject({
      video: 'video.webm',
      fps: 30,
      framesKept: false,
      note: null,
    });
    expect(meta.motion.desktop!.segments).toEqual([
      { name: 'load', start: 0, seconds: expect.any(Number), frames: expect.any(Number) },
    ]);
    expect(meta.motion.desktop!.segments[0]!.frames).toBeGreaterThan(0);
    // the load segment stops where settle starts: the scroll sweep is the capture's own doing
    // and two walks of the same page sweep at their own pace
    expect(meta.motion.desktop!.settleAt).toBeGreaterThan(0);
    expect(meta.motion.desktop!.segments[0]!.seconds).toBeLessThanOrEqual(
      meta.motion.desktop!.settleAt! / 1000,
    );
    await expect(fs.stat(path.join(dir, 'desktop', UNIT_FILES.video))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(dir, 'desktop', UNIT_FILES.frames))).rejects.toThrow();
    // the live counter is masked by its own box plus MASK_PAD, at both viewports, not by a
    // padded grid cell: a state change one cell away from it stays visible to verify
    const COUNTER =
      'body>main:nth-of-type(1)>section:nth-of-type(1)>p:nth-of-type(2)>strong:nth-of-type(1)';
    for (const vp of ['mobile', 'desktop'] as const) {
      const want = padRect(styles[vp][COUNTER]!.bbox, MASK_PAD);
      expect(meta.masks[vp], vp).toHaveLength(1);
      const got = meta.masks[vp][0]!;
      for (const k of ['x', 'y', 'width', 'height'] as const)
        expect(got[k], `${vp} ${k}`).toBeCloseTo(want[k], 2);
    }
    expect(meta.failedAssets).toEqual([]);

    const assets = await readJson(AssetIndexSchema, path.join(dir, UNIT_FILES.assetsIndex));
    expect(assets.some((a) => a.kind === 'font')).toBe(true);
    expect(assets.some((a) => a.kind === 'image' && a.url.endsWith('/hero.png'))).toBe(true);
    expect(assets.some((a) => a.kind === 'stylesheet')).toBe(true);
    for (const a of assets)
      await expect(fs.stat(path.join(dir, 'assets', a.file))).resolves.toBeTruthy();

    const text = await readJson(TextFileSchema, path.join(dir, UNIT_FILES.text));
    expect(text.some((t) => t.text === 'Know before you go')).toBe(true);

    const snapshot = await fs.readFile(path.join(dir, UNIT_FILES.snapshot), 'utf8');
    expect(snapshot).toContain('<style>');
    expect(
      snapshot.includes('data:font/woff2') || snapshot.includes('data:application/octet-stream'),
    ).toBe(true);
    expect(snapshot).not.toContain('href="/styles.css"');

    const animations = await readJson(AnimationsFileSchema, path.join(dir, UNIT_FILES.animations));
    expect(animations.keyframes['pulse']).toEqual({
      from: 'cssom',
      stops: [
        { offset: '0%', declarations: { transform: 'scale(1)' } },
        { offset: '50%', declarations: { transform: 'scale(1.08)' } },
        { offset: '100%', declarations: { transform: 'scale(1)' } },
      ],
    });
    expect(animations.keyframes['fadeIn']!.from).toBe('cssom');
    const HERO = 'body>main:nth-of-type(1)>section:nth-of-type(1)';
    expect(animations.elements.desktop[`${HERO}>span:nth-of-type(1)`]).toMatchObject({
      animation: {
        'animation-name': 'pulse',
        'animation-duration': '2s',
        'animation-timing-function': 'ease-in-out',
        'animation-iteration-count': 'infinite',
      },
      transition: null,
    });
    expect(animations.elements.desktop[`${HERO}>a:nth-of-type(1)`]).toMatchObject({
      animation: null,
      transition: { 'transition-property': 'background-color', 'transition-duration': '0.2s' },
    });
    // the lede declares neither and is not listed
    expect(animations.elements.desktop[`${HERO}>p:nth-of-type(1)`]).toBeUndefined();
    expect(animations.observed.desktop.map((a) => a.name).sort()).toEqual(['fadeIn', 'pulse']);
    expect(animations.observed.desktop.every((a) => a.phase === 'load' && a.path !== null)).toBe(
      true,
    );
    expect(animations.unreadableStylesheets).toEqual([]);
  });

  it('captures a page whose font files are all hashed', async () => {
    const dir = await fixtureCopy(async (d) => {
      await fs.rename(
        path.join(d, 'fonts', 'Fixture-Regular.woff2'),
        path.join(d, 'fonts', 'b9c8d7e6f5.woff2'),
      );
      const css = await fs.readFile(path.join(d, 'styles.css'), 'utf8');
      await fs.writeFile(
        path.join(d, 'styles.css'),
        css.replace('/fonts/Fixture-Regular.woff2', '/fonts/b9c8d7e6f5.woff2'),
      );
    });
    const hashed = await serveStatic(dir);
    try {
      const pack = new PackPaths(await tmp('site-pack-'));
      const summary = await capturePageUnit({
        pack,
        unitId: 'page:index',
        url: `${hashed.url}/`,
        viewports: [DEFAULT_VIEWPORTS.desktop],
        session,
      });
      // no filename names the family, and there are two font files: @font-face maps each face anyway
      const faces = summary.meta.fonts.filter((f) => f.status === 'loaded');
      expect(faces.map((f) => f.weight).sort()).toEqual(['400', '700']);
      expect(faces.find((f) => f.weight === '400')?.file).toMatch(/b9c8d7e6f5\.woff2$/);
      expect(faces.find((f) => f.weight === '700')?.file).toMatch(/a1b2c3d4e5\.woff2$/);
    } finally {
      await hashed.close();
    }
  });

  it('rejects when the page loads a web font and no font file was captured', async () => {
    // a font url the server 404s is not this case: the face then reports status 'error', not
    // 'loaded'. a font served under an extension the store does not read as a font is.
    const dir = await fixtureCopy(async (d) => {
      await fs.rename(
        path.join(d, 'fonts', 'Fixture-Regular.woff2'),
        path.join(d, 'fonts', 'regular.bin'),
      );
      await fs.rename(path.join(d, 'fonts', 'a1b2c3d4e5.woff2'), path.join(d, 'fonts', 'bold.bin'));
      const css = await fs.readFile(path.join(d, 'styles.css'), 'utf8');
      await fs.writeFile(
        path.join(d, 'styles.css'),
        css
          .replace('/fonts/Fixture-Regular.woff2', '/fonts/regular.bin')
          .replace('/fonts/a1b2c3d4e5.woff2', '/fonts/bold.bin'),
      );
    });
    const uncaptured = await serveStatic(dir);
    try {
      const pack = new PackPaths(await tmp('site-pack-'));
      await expect(
        capturePageUnit({
          pack,
          unitId: 'page:index',
          url: `${uncaptured.url}/`,
          viewports: [DEFAULT_VIEWPORTS.desktop],
          session,
        }),
      ).rejects.toMatchObject({
        code: ERROR_CODES.fontsMissing,
        message: expect.stringMatching(/not captured/),
      });
      await expect(fs.stat(pack.pageDir('index'))).rejects.toThrow();
    } finally {
      await uncaptured.close();
    }
  });

  it('blocks a page whose http faces were not captured even when an inline face decoded', async () => {
    // the decoded inline face is a font file in the store, and it must not stand in for the
    // fetched ones: the guard counts only what could have crossed the wire
    const bytes = await fs.readFile(path.resolve('test/fixtures/site/fonts/Fixture-Regular.woff2'));
    const dir = await fixtureCopy(async (d) => {
      await fs.rename(
        path.join(d, 'fonts', 'Fixture-Regular.woff2'),
        path.join(d, 'fonts', 'regular.bin'),
      );
      await fs.rename(path.join(d, 'fonts', 'a1b2c3d4e5.woff2'), path.join(d, 'fonts', 'bold.bin'));
      const css = await fs.readFile(path.join(d, 'styles.css'), 'utf8');
      await fs.writeFile(
        path.join(d, 'styles.css'),
        css
          .replace('/fonts/Fixture-Regular.woff2', '/fonts/regular.bin')
          .replace('/fonts/a1b2c3d4e5.woff2', '/fonts/bold.bin') +
          `\n@font-face { font-family: 'Inline'; src: url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2'); font-weight: 400; font-style: normal; }\n.lede { font-family: 'Inline', sans-serif; }\n`,
      );
    });
    const mixed = await serveStatic(dir);
    try {
      await expect(
        capturePageUnit({
          pack: new PackPaths(await tmp('site-pack-')),
          unitId: 'page:index',
          url: `${mixed.url}/`,
          viewports: [DEFAULT_VIEWPORTS.desktop],
          session,
        }),
      ).rejects.toMatchObject({ code: ERROR_CODES.fontsMissing });
    } finally {
      await mixed.close();
    }
  });

  /** a page whose only @font-face is `src`, with the family applied to its body. */
  async function fontPage(prefix: string, src: string): Promise<string> {
    const dir = await tmp(prefix);
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Embedded font</title>' +
        `<style>@font-face { font-family: 'Embedded'; src: ${src}; font-weight: 400; ` +
        "font-style: normal; }\nbody { font-family: 'Embedded', serif; }</style></head>" +
        '<body><main><section style="height:200px"><h1>Embedded font</h1>' +
        '<p>set in the embedded face</p></section></main></body></html>',
    );
    return dir;
  }

  it('captures a page whose only font face is a data: url', async () => {
    // nothing was fetched: the face's bytes are decoded out of the url into assets/, and the
    // font maps to that file like any other
    const woff2 = await fs.readFile(path.resolve('test/fixtures/site/fonts/Fixture-Regular.woff2'));
    const dir = await fontPage(
      'site-datafont-',
      `url(data:font/woff2;base64,${woff2.toString('base64')}) format('woff2')`,
    );
    const inline = await serveStatic(dir);
    try {
      const summary = await capturePageUnit({
        pack: new PackPaths(await tmp('site-pack-')),
        unitId: 'page:index',
        url: `${inline.url}/`,
        viewports: [DEFAULT_VIEWPORTS.desktop],
        session,
      });
      const face = summary.meta.fonts.find((f) => f.family === 'Embedded');
      expect(face).toMatchObject({ status: 'loaded' });
      expect(face?.file).toMatch(/^font-[0-9a-f]{8}-inline-embedded-400\.woff2$/);
      expect(face?.url?.startsWith('data:font/woff2;base64,')).toBe(true);
    } finally {
      await inline.close();
    }
  });

  it('records a data: face it cannot decode as a failed asset and captures the page anyway', async () => {
    // a malformed escape and a url with no media type: neither is a font, and neither may
    // abort the unit the way an uncaught decode error would
    for (const [prefix, src] of [
      ['site-badescape-', 'url(data:font/woff2,%zz)'],
      ['site-notype-', 'url(data:,plain)'],
    ] as const) {
      const dir = await fontPage(prefix, `${src} format('woff2')`);
      const served = await serveStatic(dir);
      try {
        const summary = await capturePageUnit({
          pack: new PackPaths(await tmp('site-pack-')),
          unitId: 'page:index',
          url: `${served.url}/`,
          viewports: [DEFAULT_VIEWPORTS.desktop],
          session,
        });
        expect(summary.meta.failedAssets, src).toEqual([
          { url: expect.stringMatching(/^data:/), reason: expect.any(String) },
        ]);
        expect(summary.meta.failedAssets[0]!.reason.length, src).toBeGreaterThan(0);
        expect(
          summary.meta.fonts.find((f) => f.family === 'Embedded')?.file ?? null,
          src,
        ).toBeNull();
      } finally {
        await served.close();
      }
    }
  });

  it('captures a page whose only font face is a local() family', async () => {
    const dir = await fontPage('site-localfont-', "local('Helvetica')");
    const local = await serveStatic(dir);
    try {
      const summary = await capturePageUnit({
        pack: new PackPaths(await tmp('site-pack-')),
        unitId: 'page:index',
        url: `${local.url}/`,
        viewports: [DEFAULT_VIEWPORTS.desktop],
        session,
      });
      const face = summary.meta.fonts.find((f) => f.family === 'Embedded');
      expect(face).toMatchObject({ status: 'loaded', file: null, url: null });
    } finally {
      await local.close();
    }
  });

  it('captures a page whose fine print mentions recaptcha', async () => {
    const dir = await tmp('site-fineprint-');
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Contact Fixture Co</title></head>' +
        '<body><main><section class="contact"><h1>Contact us</h1>' +
        '<form><label>Email <input type="email" name="email" /></label><button type="submit">Send</button></form>' +
        '<p class="fineprint">This form is protected by reCAPTCHA.</p></section></main></body></html>',
    );
    const fineprint = await serveStatic(dir);
    try {
      const pack = new PackPaths(await tmp('site-pack-'));
      const summary = await capturePageUnit({
        pack,
        unitId: 'page:contact',
        url: `${fineprint.url}/`,
        viewports: [DEFAULT_VIEWPORTS.desktop],
        session,
      });
      expect(summary.meta.title).toBe('Contact Fixture Co');
    } finally {
      await fineprint.close();
    }
  });

  it('leaves nothing behind when capture fails', async () => {
    const pack = new PackPaths(root);
    await expect(
      capturePageUnit({
        pack,
        unitId: 'page:missing',
        url: `${server.url}/does-not-exist.html`,
        viewports: [DEFAULT_VIEWPORTS.desktop],
        session,
      }),
    ).rejects.toThrow(/404/);
    await expect(fs.stat(pack.pageDir('missing'))).rejects.toThrow();
  });

  it('reaches a hover state through prepare after the sweep and keeps the menu open for the shots', async () => {
    const pack = new PackPaths(root);
    const summary = await capturePageUnit({
      pack,
      unitId: 'state:index/hover-nav-products',
      url: `${server.url}/`,
      viewports: [DEFAULT_VIEWPORTS.mobile, DEFAULT_VIEWPORTS.desktop],
      session,
      reachedBy: 'replay',
      prepare: (page) => page.getByRole('button', { name: 'Products' }).hover(),
      motion: { fps: 30, keepFrames: true },
    });
    expect(summary.unitDir).toBe(pack.stateDir('index', 'hover-nav-products'));
    expect(summary.meta.reachedBy).toBe('replay');
    const MENU =
      'body>header:nth-of-type(1)>nav:nth-of-type(1)>ul:nth-of-type(1)>li:nth-of-type(1)>ul:nth-of-type(1)';
    const styles = await readJson(StylesFileSchema, path.join(summary.unitDir, UNIT_FILES.styles));
    expect(styles.desktop[MENU]?.styles['display']).toBe('block');
    expect(styles.mobile[MENU]?.styles['display']).toBe('block');
    const text = await readJson(TextFileSchema, path.join(summary.unitDir, UNIT_FILES.text));
    expect(text.some((t) => t.text === 'Scanner')).toBe(true);
    // the interaction is its own segment, after the load, and the frames stayed on disk
    const motion = summary.meta.motion.desktop!;
    expect(motion.framesKept).toBe(true);
    expect(motion.segments.map((s) => s.name)).toEqual(['load', 'prepare']);
    expect(motion.segments[1]!.start).toBeGreaterThan(0);
    expect(motion.segments[1]!.frames).toBeGreaterThan(0);
    const framesDir = path.join(summary.unitDir, 'desktop', UNIT_FILES.frames);
    await expect(fs.stat(path.join(framesDir, UNIT_FILES.frame('load', 1)))).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(framesDir, UNIT_FILES.frame('prepare', 1))),
    ).resolves.toBeTruthy();
  });

  it('skips a viewport a state cannot reach and fails only when none can', async () => {
    const pack = new PackPaths(root);
    const unreachableBelow = (width: number) => async (page: Page) => {
      if ((page.viewportSize()?.width ?? 0) < width) {
        throw Object.assign(new Error('menu hidden at this width'), {
          code: ERROR_CODES.unreachable,
        });
      }
    };
    const summary = await capturePageUnit({
      pack,
      unitId: 'state:index/desktop-only',
      url: `${server.url}/`,
      viewports: [DEFAULT_VIEWPORTS.mobile, DEFAULT_VIEWPORTS.desktop],
      session,
      prepare: unreachableBelow(600),
    });
    expect(summary.meta.pageHeight.mobile).toBe(0);
    expect(summary.meta.pageHeight.desktop).toBeGreaterThan(0);
    expect(summary.sections[0]!.bbox.mobile).toBeNull();
    await expect(fs.stat(path.join(summary.unitDir, 'mobile'))).rejects.toThrow();
    await expect(
      fs.stat(path.join(summary.unitDir, 'desktop', UNIT_FILES.full)),
    ).resolves.toBeTruthy();
    await expect(
      capturePageUnit({
        pack,
        unitId: 'state:index/nowhere',
        url: `${server.url}/`,
        viewports: [DEFAULT_VIEWPORTS.desktop],
        session,
        prepare: unreachableBelow(10_000),
      }),
    ).rejects.toThrow(/not reachable at any viewport/);
    await expect(fs.stat(pack.stateDir('index', 'nowhere'))).rejects.toThrow();
  });

  it("keeps a page's states dir when the page is captured again", async () => {
    // the hover state captured two tests up lives under pages/index/states
    const pack = new PackPaths(root);
    await capturePageUnit({
      pack,
      unitId: 'page:index',
      url: `${server.url}/`,
      viewports: [DEFAULT_VIEWPORTS.desktop],
      session,
    });
    await expect(
      fs.stat(path.join(pack.stateDir('index', 'hover-nav-products'), UNIT_FILES.meta)),
    ).resolves.toBeTruthy();
    const siblings = await fs.readdir(path.join(root, 'pages'));
    expect(siblings.filter((n) => n.includes('.old-'))).toEqual([]);
  });

  it('captures the app fixture: a wrapped root, a section with no mobile box, a mobile-only element', async () => {
    const pack = new PackPaths(root);
    const summary = await capturePageUnit({
      pack,
      unitId: 'page:app',
      url: `${server.url}/app.html`,
      viewports: [DEFAULT_VIEWPORTS.mobile, DEFAULT_VIEWPORTS.desktop],
      session,
    });
    expect(summary.meta.title).toBe('Fixture App');
    expect(summary.sections.map((s) => s.role)).toEqual([
      'header',
      'hero',
      'features',
      'section',
      'form',
      'footer',
    ]);
    const wide = summary.sections[3]!;
    expect(wide.id).toBe('s04-section-only-on-wide-screens');
    expect(wide.bbox.desktop).not.toBeNull();
    expect(wide.bbox.mobile).toBeNull();
    await expect(
      fs.stat(path.join(summary.unitDir, 'desktop', UNIT_FILES.section(wide.id))),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(summary.unitDir, 'mobile', UNIT_FILES.section(wide.id))),
    ).rejects.toThrow();
    const styles = await readJson(StylesFileSchema, path.join(summary.unitDir, UNIT_FILES.styles));
    const NOTE =
      'body>div:nth-of-type(1)>div:nth-of-type(1)>section:nth-of-type(1)>p:nth-of-type(2)';
    expect(styles.mobile[NOTE]?.tag).toBe('p');
    expect(styles.desktop[NOTE]).toBeUndefined();
  });

  it('freezes what it can and tolerates an animation that cannot be finished', async () => {
    const dir = await tmp('site-anim-');
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><html><head><style>@keyframes k{to{opacity:.5}}.a{animation:k 1s forwards}.b{animation:k 1s infinite}</style></head>' +
        '<body><p class="a">a</p><p class="b">b</p>' +
        '<script>document.getAnimations().forEach(function (an) { if (an.effect.target.className === "a") an.playbackRate = 0; });</script>' +
        '</body></html>',
    );
    const anim = await serveStatic(dir);
    const opened = await openPage(session, DEFAULT_VIEWPORTS.desktop);
    try {
      await opened.page.goto(`${anim.url}/`, { waitUntil: 'load' });
      // the finite one has playbackRate 0, so finish() throws; the endless one is parked
      await expect(freezeAnimations(opened.page)).resolves.toBe(1);
      const parked = await opened.page.evaluate(() =>
        document.getAnimations().some((a) => a.playState === 'paused' && a.currentTime === 0),
      );
      expect(parked).toBe(true);
    } finally {
      await opened.release();
      await anim.close();
    }
  });

  it('finds no masks on a page with nothing live', async () => {
    const summary = await capturePageUnit({
      pack: new PackPaths(root),
      unitId: 'page:about',
      url: `${server.url}/about.html`,
      viewports: [DEFAULT_VIEWPORTS.desktop],
      session,
    });
    expect(summary.meta.masks.desktop).toEqual([]);
    expect(summary.meta.motion.desktop).toBeNull();
  });

  it('masks a live element below the fold by its own box', async () => {
    const dir = await tmp('site-deep-');
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><html><head><style>body{margin:0} .spacer{height:2400px} #tick{display:inline-block;width:3ch}</style></head>' +
        '<body><div class="spacer"></div><p>Ticks: <strong id="tick">0</strong></p>' +
        '<script>var n=0;setInterval(function(){n++;document.getElementById("tick").textContent=String(n)},300)</script></body></html>',
    );
    const deep = await serveStatic(dir);
    try {
      const summary = await capturePageUnit({
        pack: new PackPaths(await tmp('site-pack-')),
        unitId: 'page:deep',
        url: `${deep.url}/`,
        viewports: [DEFAULT_VIEWPORTS.desktop],
        session,
      });
      const styles = await readJson(
        StylesFileSchema,
        path.join(summary.unitDir, UNIT_FILES.styles),
      );
      const tick = styles.desktop['body>p:nth-of-type(1)>strong:nth-of-type(1)']!.bbox;
      expect(tick.y).toBeGreaterThan(2000);
      expect(summary.meta.masks.desktop).toHaveLength(1);
      const want = padRect(tick, MASK_PAD);
      const got = summary.meta.masks.desktop[0]!;
      for (const k of ['x', 'y', 'width', 'height'] as const)
        expect(got[k], k).toBeCloseTo(want[k], 2);
    } finally {
      await deep.close();
    }
  });

  it('masks the live element under a full-viewport overlay, not the overlay', async () => {
    // a modal backdrop or a fixed transparent wrapper is the topmost element over every
    // changed pixel; owning the change would mask the whole viewport and blind verify
    const dir = await tmp('site-veil-');
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><html><head><style>body{margin:0} #tick{display:inline-block;width:3ch}' +
        '.veil{position:fixed;inset:0;background:transparent}</style></head>' +
        '<body><p>Ticks: <strong id="tick">0</strong></p><div class="veil"></div>' +
        '<script>var n=0;setInterval(function(){n++;document.getElementById("tick").textContent=String(n)},300)</script></body></html>',
    );
    const veiled = await serveStatic(dir);
    try {
      const summary = await capturePageUnit({
        pack: new PackPaths(await tmp('site-pack-')),
        unitId: 'page:veiled',
        url: `${veiled.url}/`,
        viewports: [DEFAULT_VIEWPORTS.desktop],
        session,
      });
      const styles = await readJson(
        StylesFileSchema,
        path.join(summary.unitDir, UNIT_FILES.styles),
      );
      const tick = styles.desktop['body>p:nth-of-type(1)>strong:nth-of-type(1)']!.bbox;
      expect(summary.meta.masks.desktop).toHaveLength(1);
      const want = padRect(tick, MASK_PAD);
      const got = summary.meta.masks.desktop[0]!;
      for (const k of ['x', 'y', 'width', 'height'] as const)
        expect(got[k], k).toBeCloseTo(want[k], 2);
    } finally {
      await veiled.close();
    }
  });

  it('masks the counter behind an open modal by its own box at both viewports', async () => {
    // the fixture's modal is position: fixed; inset: 0, so it is painted over every pixel the
    // live counter changes. the state's own capture must still mask the counter, not the page
    const summary = await capturePageUnit({
      pack: new PackPaths(await tmp('site-pack-')),
      unitId: 'state:index/modal-talk-to-us',
      url: `${server.url}/`,
      viewports: [DEFAULT_VIEWPORTS.mobile, DEFAULT_VIEWPORTS.desktop],
      session,
      reachedBy: 'replay',
      prepare: (page) => page.getByRole('button', { name: 'Talk to us' }).click(),
    });
    const styles = await readJson(StylesFileSchema, path.join(summary.unitDir, UNIT_FILES.styles));
    const COUNTER =
      'body>main:nth-of-type(1)>section:nth-of-type(1)>p:nth-of-type(2)>strong:nth-of-type(1)';
    for (const vp of ['mobile', 'desktop'] as const) {
      const want = padRect(styles[vp][COUNTER]!.bbox, MASK_PAD);
      expect(summary.meta.masks[vp], vp).toHaveLength(1);
      const got = summary.meta.masks[vp][0]!;
      for (const k of ['x', 'y', 'width', 'height'] as const)
        expect(got[k], `${vp} ${k}`).toBeCloseTo(want[k], 2);
      expect(got.width, `${vp} width`).toBeLessThan(DEFAULT_VIEWPORTS[vp].width / 4);
    }
  });

  it('keeps the padded cell when the change is painted on the body itself', async () => {
    const dir = await tmp('site-bodybg-');
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><html><head><style>html,body{margin:0;height:100%} body{background:repeating-linear-gradient(90deg,#000 0 20px,#fff 20px 40px)}</style></head>' +
        '<body><script>var o=0;setInterval(function(){o+=10;document.body.style.backgroundPosition=o+"px 0"},300)</script></body></html>',
    );
    const moving = await serveStatic(dir);
    try {
      const summary = await capturePageUnit({
        pack: new PackPaths(await tmp('site-pack-')),
        unitId: 'page:moving',
        url: `${moving.url}/`,
        viewports: [DEFAULT_VIEWPORTS.desktop],
        session,
      });
      expect(summary.meta.masks.desktop.length).toBeGreaterThan(0);
      for (const m of summary.meta.masks.desktop) {
        expect(m.x % MASK_CELL).toBe(0);
        expect(m.y % MASK_CELL).toBe(0);
      }
    } finally {
      await moving.close();
    }
  });

  it('masks a carousel whose slides swap slower than the default rest shots span', async () => {
    // the slide wrapper carries no carousel class or attribute on purpose: the mask has to
    // come from the rest shots the manifest asked for, not from extractPage's hint list
    const dir = await tmp('site-slides-');
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Slides</title>' +
        '<style>body{margin:0}</style></head><body><main><section style="height:400px">' +
        '<h1>Slides</h1><div id="slides" style="width:300px;height:200px;position:relative">' +
        '<div class="a" style="position:absolute;inset:0;background:#2563eb"></div>' +
        '<div class="b" style="position:absolute;inset:0;background:#f59e0b;display:none"></div>' +
        '</div></section></main>' +
        '<script>var a=document.querySelector(".a"),b=document.querySelector(".b"),on=true;' +
        'setInterval(function(){on=!on;a.style.display=on?"block":"none";' +
        'b.style.display=on?"none":"block"},5000)</script></body></html>',
    );
    const slides = await serveStatic(dir);
    try {
      const root = await tmp('site-pack-');
      await explore({ root, url: `${slides.url}/`, depth: 0, scope: [], session, states: false });
      const manifest = await loadManifest(root);
      // three shots three seconds apart span six seconds, so a five-second swap is caught;
      // the defaults span three and would see the same slide every time
      manifest.capture.dynamicShots = 3;
      manifest.capture.dynamicGap = 3000;
      await saveManifest(root, manifest);
      await captureAll({ root, session });
      const unitDir = new PackPaths(root).pageDir('index');
      const meta = await readJson(PageMetaSchema, path.join(unitDir, UNIT_FILES.meta));
      const styles = await readJson(StylesFileSchema, path.join(unitDir, UNIT_FILES.styles));
      const box =
        styles.desktop['body>main:nth-of-type(1)>section:nth-of-type(1)>div:nth-of-type(1)']!.bbox;
      const over = meta.masks.desktop.find(
        (m) =>
          m.x <= box.x &&
          m.y <= box.y &&
          m.x + m.width >= box.x + box.width &&
          m.y + m.height >= box.y + box.height,
      );
      expect(over, JSON.stringify(meta.masks.desktop)).toBeDefined();
    } finally {
      await slides.close();
    }
  }, 300_000);

  it('recovers keyframes and font faces from a cross-origin stylesheet through its captured body', async () => {
    const dir = await tmp('site-xo-');
    await fs.writeFile(
      path.join(dir, 'index.html'),
      `<!doctype html><html><head><title>Cross</title><link rel="stylesheet" href="${server.url}/styles.css"></head>` +
        '<body><main><section class="hero"><span class="badge">New</span><h1>Cross origin</h1>' +
        '<p class="lede">Styled from another origin.</p></section></main></body></html>',
    );
    const other = await serveStatic(dir);
    try {
      const summary = await capturePageUnit({
        pack: new PackPaths(await tmp('site-pack-')),
        unitId: 'page:cross',
        url: `${other.url}/`,
        viewports: [DEFAULT_VIEWPORTS.desktop],
        session,
      });
      const animations = await readJson(
        AnimationsFileSchema,
        path.join(summary.unitDir, UNIT_FILES.animations),
      );
      expect(animations.unreadableStylesheets).toEqual([`${server.url}/styles.css`]);
      expect(animations.keyframes['pulse']).toEqual({
        from: 'stylesheet',
        stops: [
          { offset: '0%', declarations: { transform: 'scale(1)' } },
          { offset: '50%', declarations: { transform: 'scale(1.08)' } },
          { offset: '100%', declarations: { transform: 'scale(1)' } },
        ],
      });
      expect(animations.keyframes['fadeIn']!.from).toBe('stylesheet');
      // the src urls resolve against the stylesheet's url, not the page's, so the fonts map
      const files = summary.meta.fonts.filter((f) => f.family === 'Fixture').map((f) => f.file);
      expect(files).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/Fixture-Regular\.woff2$/),
          expect.stringMatching(/a1b2c3d4e5\.woff2$/),
        ]),
      );
    } finally {
      await other.close();
    }
  });

  it('keeps the video and says why when ffmpeg is missing', async () => {
    const summary = await capturePageUnit({
      pack: new PackPaths(await tmp('site-pack-')),
      unitId: 'page:about',
      url: `${server.url}/about.html`,
      viewports: [DEFAULT_VIEWPORTS.desktop],
      session,
      // keepFrames is asked for and still gets none: there was nothing to split with
      motion: {
        fps: 30,
        keepFrames: true,
        resolveFfmpeg: () => Promise.reject(new Error('ffmpeg not found: brew install ffmpeg')),
      },
    });
    expect(summary.meta.motion.desktop).toMatchObject({
      video: 'video.webm',
      segments: [],
      framesKept: false,
    });
    expect(summary.meta.motion.desktop!.note).toMatch(/brew install ffmpeg/);
    const vdir = path.join(summary.unitDir, 'desktop');
    await expect(fs.stat(path.join(vdir, UNIT_FILES.video))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(vdir, UNIT_FILES.frames))).rejects.toThrow();
  });

  it('captures the unit anyway when ffmpeg fails on the recording', async () => {
    // the shape of a truncated webm or a full disk: ffmpeg runs and exits non-zero
    const bin = await tmp('site-ffmpeg-');
    const failing = path.join(bin, 'ffmpeg-fails');
    await fs.writeFile(failing, '#!/bin/sh\necho "moov atom not found" >&2\nexit 1\n');
    await fs.chmod(failing, 0o755);
    const summary = await capturePageUnit({
      pack: new PackPaths(await tmp('site-pack-')),
      unitId: 'page:about',
      url: `${server.url}/about.html`,
      viewports: [DEFAULT_VIEWPORTS.desktop],
      session,
      motion: { fps: 30, keepFrames: true, resolveFfmpeg: () => Promise.resolve(failing) },
    });
    // the unit is captured: only the report the frames would feed is lost
    expect(summary.meta.title).toBe('About Fixture Co');
    await expect(fs.stat(path.join(summary.unitDir, UNIT_FILES.meta))).resolves.toBeTruthy();
    expect(summary.meta.motion.desktop).toMatchObject({
      video: 'video.webm',
      segments: [],
      framesKept: false,
    });
    expect(summary.meta.motion.desktop!.note).toMatch(/ffmpeg-fails/);
    const vdir = path.join(summary.unitDir, 'desktop');
    await expect(fs.stat(path.join(vdir, UNIT_FILES.video))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(vdir, UNIT_FILES.frames))).rejects.toThrow();
  });

  it('blocks a unit whose fonts were not captured instead of aborting the run', async () => {
    const dir = await fixtureCopy(async (d) => {
      await fs.rename(
        path.join(d, 'fonts', 'Fixture-Regular.woff2'),
        path.join(d, 'fonts', 'regular.bin'),
      );
      await fs.rename(path.join(d, 'fonts', 'a1b2c3d4e5.woff2'), path.join(d, 'fonts', 'bold.bin'));
      const css = await fs.readFile(path.join(d, 'styles.css'), 'utf8');
      await fs.writeFile(
        path.join(d, 'styles.css'),
        css
          .replace('/fonts/Fixture-Regular.woff2', '/fonts/regular.bin')
          .replace('/fonts/a1b2c3d4e5.woff2', '/fonts/bold.bin'),
      );
    });
    const uncaptured = await serveStatic(dir);
    try {
      const root = await tmp('site-pack-');
      await explore({
        root,
        url: `${uncaptured.url}/`,
        depth: 0,
        scope: [],
        session,
        states: false,
      });
      const r = await captureAll({ root, session });
      expect(r.blocked).toEqual(['page:index']);
      const unit = (await loadManifest(root)).units['page:index']!;
      expect(unit.status).toBe('blocked');
      expect(unit.blockedReason).toBe(ERROR_CODES.fontsMissing);
      expect(unit.question).toMatch(/Fixture/);
    } finally {
      await uncaptured.close();
    }
  });

  it('parks an animation with no effect at zero instead of throwing', async () => {
    const opened = await openPage(session, DEFAULT_VIEWPORTS.desktop);
    try {
      await opened.page.setContent('<p>x</p>');
      // document.getAnimations never lists an effect-less animation (probed on this chromium),
      // so the branch is reached through a stand-in the page hands back in its place
      await opened.page.evaluate(() => {
        const fake = {
          effect: null,
          paused: false,
          currentTime: 250,
          pause() {
            this.paused = true;
          },
          finish() {
            throw new Error('finish must not be called on an effect-less animation');
          },
        };
        (window as unknown as { fake: typeof fake }).fake = fake;
        document.getAnimations = () => [fake as unknown as Animation];
      });
      await expect(freezeAnimations(opened.page)).resolves.toBe(1);
      const state = await opened.page.evaluate(() => {
        const f = (window as unknown as { fake: { paused: boolean; currentTime: number } }).fake;
        return [f.paused, f.currentTime];
      });
      expect(state).toEqual([true, 0]);
    } finally {
      await opened.release();
    }
  });

  it('records a failed asset once, not once per viewport', async () => {
    const dir = await tmp('site-404-');
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<!doctype html><html><head><title>Missing image</title></head><body><main><section style="height:200px"><h1>Hi</h1><img src="/missing.png" alt="gone" width="100" height="100"></section></main></body></html>',
    );
    const broken = await serveStatic(dir);
    try {
      const summary = await capturePageUnit({
        pack: new PackPaths(await tmp('site-pack-')),
        unitId: 'page:broken',
        url: `${broken.url}/`,
        viewports: [DEFAULT_VIEWPORTS.mobile, DEFAULT_VIEWPORTS.desktop],
        session,
      });
      expect(summary.meta.failedAssets).toEqual([
        { url: `${broken.url}/missing.png`, reason: 'http 404' },
      ]);
    } finally {
      await broken.close();
    }
  });

  it('lists a stylesheet the parser choked on in meta.json, and nothing when every sheet parsed', async () => {
    const clean = await capturePageUnit({
      pack: new PackPaths(await tmp('site-pack-')),
      unitId: 'page:index',
      url: `${server.url}/`,
      viewports: [DEFAULT_VIEWPORTS.desktop],
      session,
    });
    expect(clean.meta.stylesheetParseErrors).toEqual([]);
    const dir = await fixtureCopy(async (d) => {
      await fs.appendFile(path.join(d, 'styles.css'), '\n.broken { color: rgb( ; }\n');
    });
    const broken = await serveStatic(dir);
    try {
      const summary = await capturePageUnit({
        pack: new PackPaths(await tmp('site-pack-')),
        unitId: 'page:index',
        url: `${broken.url}/`,
        viewports: [DEFAULT_VIEWPORTS.mobile, DEFAULT_VIEWPORTS.desktop],
        session,
      });
      // one entry for the sheet, whichever viewport parsed it first
      expect(summary.meta.stylesheetParseErrors).toEqual([
        { url: `${broken.url}/styles.css`, errors: expect.any(Number) },
      ]);
      expect(summary.meta.stylesheetParseErrors[0]!.errors).toBeGreaterThan(0);
    } finally {
      await broken.close();
    }
  });

  it('decodes a data: font face into assets/ and holds the rebuild to its bytes', async () => {
    const bytes = await fs.readFile(path.resolve('test/fixtures/site/fonts/Fixture-Regular.woff2'));
    const dir = await fixtureCopy(async (d) => {
      await fs.appendFile(
        path.join(d, 'styles.css'),
        `\n@font-face { font-family: 'Inline'; src: url(data:font/woff2;base64,${bytes.toString('base64')}) format('woff2'); font-weight: 400; font-style: normal; }\n.lede { font-family: 'Inline', sans-serif; }\n`,
      );
    });
    const inline = await serveStatic(dir);
    try {
      const summary = await capturePageUnit({
        pack: new PackPaths(await tmp('site-pack-')),
        unitId: 'page:index',
        url: `${inline.url}/`,
        viewports: [DEFAULT_VIEWPORTS.desktop],
        session,
      });
      const font = summary.meta.fonts.find((f) => f.family === 'Inline');
      expect(font?.file).toMatch(/^font-[0-9a-f]{8}-inline-inline-400\.woff2$/);
      expect(font?.url?.startsWith('data:font/woff2;base64,')).toBe(true);
      const saved = await fs.readFile(path.join(summary.unitDir, 'assets', font!.file!));
      expect(saved.equals(bytes)).toBe(true);
      const index = await readJson(
        AssetIndexSchema,
        path.join(summary.unitDir, UNIT_FILES.assetsIndex),
      );
      expect(index.find((e) => e.file === font!.file)).toMatchObject({
        kind: 'font',
        contentType: 'font/woff2',
        size: bytes.length,
      });
    } finally {
      await inline.close();
    }
  });
});
