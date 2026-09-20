import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../helpers/serve';
import { openPage, openSession, type Session } from '../../src/capture/session';
import { inPage } from '../../src/capture/browser/in-page';
import {
  canonicaliseKeyframes,
  keyframeStopsOf,
  observeAnimations,
  readCssomInPage,
} from '../../src/capture/animations';
import { capturePageUnit } from '../../src/capture/pipeline';
import { DEFAULT_VIEWPORTS } from '../../src/pack/defaults';
import { refFromPath } from '../../src/pack/ids';
import { readJson } from '../../src/pack/io';
import { PackPaths, UNIT_FILES } from '../../src/pack/paths';
import { AnimationsFileSchema } from '../../src/pack/schemas';

const readCssom = inPage(readCssomInPage, [keyframeStopsOf]);

const HERO = 'body>main:nth-of-type(1)>section:nth-of-type(1)';
const BADGE = `${HERO}>span:nth-of-type(1)`;
const H1 = `${HERO}>h1:nth-of-type(1)`;
const START = `${HERO}>a:nth-of-type(1)`;

let server: Awaited<ReturnType<typeof serveStatic>>;
let session: Session;
const tmpDirs: string[] = [];

async function tmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  session = await openSession({});
});
afterAll(async () => {
  await session.close();
  await server.close();
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('readCssomInPage', () => {
  it('reads nothing from a page with no stylesheets', async () => {
    const opened = await openPage(session, DEFAULT_VIEWPORTS.desktop);
    try {
      await opened.page.setContent('<p>plain</p>');
      expect(await opened.page.evaluate(readCssom, undefined)).toEqual({
        keyframes: {},
        fontFaces: [],
        unreadable: [],
      });
    } finally {
      await opened.release();
    }
  });

  it('reads keyframes and font faces from the fixture, with src urls resolved', async () => {
    const opened = await openPage(session, DEFAULT_VIEWPORTS.desktop);
    try {
      await opened.page.goto(`${server.url}/`, { waitUntil: 'load' });
      const r = await opened.page.evaluate(readCssom, undefined);
      expect(r.unreadable).toEqual([]);
      expect(r.keyframes['pulse']).toEqual([
        { offset: '0%', declarations: { transform: 'scale(1)' } },
        { offset: '50%', declarations: { transform: 'scale(1.08)' } },
        { offset: '100%', declarations: { transform: 'scale(1)' } },
      ]);
      expect(r.keyframes['fadeIn']!.map((s) => s.offset)).toEqual(['0%', '100%']);
      expect(r.fontFaces).toEqual([
        {
          family: 'Fixture',
          weight: '400',
          style: 'normal',
          urls: [`${server.url}/fonts/Fixture-Regular.woff2`],
        },
        {
          family: 'Fixture',
          weight: '700',
          style: 'normal',
          urls: [`${server.url}/fonts/a1b2c3d4e5.woff2`],
        },
      ]);
    } finally {
      await opened.release();
    }
  });

  it('lists a cross-origin stylesheet it cannot read', async () => {
    // the fixture's own stylesheet, linked from a page on another port, is cross-origin there
    const dir = await tmp('site-xo-');
    await fs.writeFile(
      path.join(dir, 'index.html'),
      `<link rel="stylesheet" href="${server.url}/styles.css"><h1>x</h1>`,
    );
    const other = await serveStatic(dir);
    const opened = await openPage(session, DEFAULT_VIEWPORTS.desktop);
    try {
      await opened.page.goto(`${other.url}/`, { waitUntil: 'load' });
      const r = await opened.page.evaluate(readCssom, undefined);
      expect(r.unreadable).toEqual([`${server.url}/styles.css`]);
      expect(r.keyframes).toEqual({});
      expect(r.fontFaces).toEqual([]);
    } finally {
      await opened.release();
      await other.close();
    }
  });

  it('walks an @import and lists a cross-origin one under its own href', async () => {
    // document.styleSheets lists the linked sheet only: without the @import walk neither
    // imported rule is seen, and the cross-origin one is reported under the importing sheet
    const dir = await tmp('site-import-');
    await fs.writeFile(
      path.join(dir, 'same.css'),
      '@keyframes imported { 0% { opacity: 0; } 100% { opacity: 1; } }\n',
    );
    await fs.writeFile(
      path.join(dir, 'near.css'),
      `@import url("/same.css");\n@import url("${server.url}/styles.css");\n` +
        '@keyframes near { 0% { opacity: 0.25; } }\n',
    );
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<link rel="stylesheet" href="/near.css"><h1>x</h1>',
    );
    const imports = await serveStatic(dir);
    const opened = await openPage(session, DEFAULT_VIEWPORTS.desktop);
    try {
      await opened.page.goto(`${imports.url}/`, { waitUntil: 'load' });
      await opened.page.waitForTimeout(300);
      const r = await opened.page.evaluate(readCssom, undefined);
      expect(Object.keys(r.keyframes).sort()).toEqual(['imported', 'near']);
      expect(r.unreadable).toEqual([`${server.url}/styles.css`]);
    } finally {
      await opened.release();
      await imports.close();
    }
  });
});

describe('keyframes in cssom spellings', () => {
  // the values a stylesheet reader and the cssom disagree about: `.5` is `0.5`, a unitless
  // zero gains its unit, and a shorthand becomes longhands
  const CSS =
    '@keyframes probe { 0% { opacity: .5; transform: translateY(0); margin: 0; ' +
    'background-position: 0 0; } 100% { opacity: 1; transform: translateY(10px); ' +
    'margin: 10px; background-position: 10px 10px; } }\n' +
    '.probe { animation: probe 2s linear infinite; }\n';
  const page = (href: string) =>
    '<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>Probe</title>' +
    `<link rel="stylesheet" href="${href}" /></head>` +
    '<body><main><section style="height:200px"><h1>Probe</h1>' +
    '<p class="probe">animated</p></section></main></body></html>';

  it('records a cross-origin rule exactly as a same-origin copy of it', async () => {
    const sheetDir = await tmp('site-kf-sheet-');
    await fs.writeFile(path.join(sheetDir, 'kf.css'), CSS);
    const sheets = await serveStatic(sheetDir);
    const farDir = await tmp('site-kf-far-');
    await fs.writeFile(path.join(farDir, 'index.html'), page(`${sheets.url}/kf.css`));
    const far = await serveStatic(farDir);
    const nearDir = await tmp('site-kf-near-');
    await fs.writeFile(path.join(nearDir, 'kf.css'), CSS);
    await fs.writeFile(path.join(nearDir, 'index.html'), page('/kf.css'));
    const near = await serveStatic(nearDir);
    try {
      const capture = async (url: string, unitId: string) => {
        const summary = await capturePageUnit({
          pack: new PackPaths(await tmp('site-pack-')),
          unitId,
          url,
          viewports: [DEFAULT_VIEWPORTS.desktop],
          session,
        });
        return readJson(AnimationsFileSchema, path.join(summary.unitDir, UNIT_FILES.animations));
      };
      const crossOrigin = await capture(`${far.url}/`, 'page:far');
      const sameOrigin = await capture(`${near.url}/`, 'page:near');
      expect(crossOrigin.unreadableStylesheets).toEqual([`${sheets.url}/kf.css`]);
      expect(crossOrigin.keyframes['probe']!.from).toBe('stylesheet');
      expect(sameOrigin.keyframes['probe']!.from).toBe('cssom');
      expect(crossOrigin.keyframes['probe']!.stops).toEqual(sameOrigin.keyframes['probe']!.stops);
      expect(crossOrigin.keyframes['probe']!.stops[0]!.declarations).toMatchObject({
        opacity: '0.5',
        transform: 'translateY(0px)',
        'margin-top': '0px',
        'background-position-x': '0px',
      });
    } finally {
      await near.close();
      await far.close();
      await sheets.close();
    }
  });

  it('canonicalises each rule in its own sheet, so one the engine rejects keeps its parsed stops and the next still comes back', async () => {
    const opened = await openPage(session, DEFAULT_VIEWPORTS.desktop);
    try {
      await opened.page.setContent('<p>x</p>');
      const bad = [{ offset: '0%', declarations: { opacity: '.5' } }];
      const out = await canonicaliseKeyframes(opened.page, {
        '1bad': bad,
        fadeIn: [{ offset: '0%', declarations: { opacity: '.5', margin: '0' } }],
      });
      // a keyframes name may not start with a digit: the engine drops the rule, the parser's stops stay
      expect(out['1bad']).toEqual(bad);
      expect(out['fadeIn']).toEqual([
        {
          offset: '0%',
          declarations: {
            opacity: '0.5',
            'margin-top': '0px',
            'margin-right': '0px',
            'margin-bottom': '0px',
            'margin-left': '0px',
          },
        },
      ]);
    } finally {
      await opened.release();
    }
  });
});

describe('observeAnimations', () => {
  it('sees nothing on a page that animates nothing', async () => {
    const opened = await openPage(session, DEFAULT_VIEWPORTS.desktop);
    try {
      const observer = await observeAnimations(opened.page);
      // every fixture page shares styles.css, whose `.hero h1` rule fires fadeIn: about.html's
      // own h1 sits in a `.hero` section, so it is not animation-free (probed: chromium fires
      // Animation.animationStarted for it ~30ms after load). a truly animation-free page needs
      // its own markup rather than a fixture url, matching readCssomInPage's own no-op test.
      await opened.page.setContent('<p>plain</p>');
      await opened.page.waitForTimeout(300);
      expect(await observer.stop()).toEqual([]);
    } finally {
      await opened.release();
    }
  });

  it('records css animations at load, a transition during prepare and a waapi animation, each on its element', async () => {
    const opened = await openPage(session, DEFAULT_VIEWPORTS.desktop);
    try {
      const { page } = opened;
      const observer = await observeAnimations(page);
      await page.goto(`${server.url}/`, { waitUntil: 'load' });
      await page.waitForTimeout(500);
      observer.mark('prepare');
      await page.getByRole('link', { name: 'Start free' }).hover();
      await page.evaluate(() => {
        document.querySelector('h1')!.animate([{ opacity: 1 }, { opacity: 0.5 }], {
          duration: 500,
          iterations: 2,
          easing: 'ease-in',
          delay: 100,
        });
      });
      await page.waitForTimeout(400);
      const seen = await observer.stop();
      expect(seen.find((a) => a.name === 'pulse')).toMatchObject({
        type: 'CSSAnimation',
        path: BADGE,
        ref: refFromPath(BADGE),
        duration: 2000,
        delay: 0,
        iterations: null,
        keyframeEasings: ['ease-in-out', 'ease-in-out', 'ease-in-out'],
        phase: 'load',
      });
      expect(seen.find((a) => a.name === 'fadeIn')).toMatchObject({
        type: 'CSSAnimation',
        path: H1,
        duration: 300,
        iterations: 1,
        phase: 'load',
      });
      expect(seen.find((a) => a.type === 'CSSTransition')).toMatchObject({
        name: 'background-color',
        path: START,
        duration: 200,
        easing: 'ease-in-out',
        phase: 'prepare',
      });
      expect(seen.find((a) => a.type === 'WebAnimation')).toMatchObject({
        name: '',
        path: H1,
        duration: 500,
        delay: 100,
        iterations: 2,
        easing: 'ease-in',
        phase: 'prepare',
      });
      const times = seen.map((a) => a.startedAt);
      expect(times).toEqual([...times].sort((a, b) => a - b));
    } finally {
      await opened.release();
    }
  });

  it("carries the animated element's data-ref, which is how the gate matches a rebuild", async () => {
    const opened = await openPage(session, DEFAULT_VIEWPORTS.desktop);
    try {
      const observer = await observeAnimations(opened.page);
      await opened.page.setContent('<h1 data-ref="rsource">x</h1>');
      await opened.page.evaluate(() => {
        document.querySelector('h1')!.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300 });
      });
      await opened.page.waitForTimeout(300);
      const seen = await observer.stop();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        type: 'WebAnimation',
        path: 'body>h1:nth-of-type(1)',
        dataRef: 'rsource',
      });
    } finally {
      await opened.release();
    }
  });
});
