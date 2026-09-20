import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { serveStatic } from '../helpers/serve';
import { extractPage, STYLE_PROPS } from '../../src/capture/browser/extract';
import { MASK_HINT_MAX_VIEWPORTS } from '../../src/pack/defaults';
import { refFromPath } from '../../src/pack/ids';

let server: Awaited<ReturnType<typeof serveStatic>>;
let browser: Browser;

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  await server.close();
});

describe('extractPage', () => {
  it('finds the fixture sections in order with roles and items', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${server.url}/`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const result = await page.evaluate(extractPage, {
      styleProps: STYLE_PROPS,
      minSectionHeight: 80,
      hintMaxViewports: MASK_HINT_MAX_VIEWPORTS,
    });
    const roles = result.sections.map((s) => s.role);
    expect(roles).toEqual(['header', 'hero', 'features', 'faq', 'cta', 'footer']);
    const features = result.sections[2]!;
    expect(features.heading).toBe('Everything you need');
    expect(features.items.map((i) => i.title)).toEqual([
      'Fast scans',
      'Deep records',
      'Private by design',
    ]);
    expect(features.items[0]!.description).toBe('Results in under a minute, every time.');
    expect(result.sections[1]!.imageCount).toBe(1);
    expect(result.sections[1]!.buttons).toContain('Start free');
    await page.close();
  });

  it('keys styles by stable path with a ref that matches the node-side hash', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${server.url}/`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const result = await page.evaluate(extractPage, {
      styleProps: STYLE_PROPS,
      minSectionHeight: 80,
      hintMaxViewports: MASK_HINT_MAX_VIEWPORTS,
    });
    const h1 = result.elements.find((e) => e.tag === 'h1');
    expect(h1).toBeDefined();
    expect(h1!.path).toBe('body>main:nth-of-type(1)>section:nth-of-type(1)>h1:nth-of-type(1)');
    expect(h1!.ref).toBe(refFromPath(h1!.path));
    expect(h1!.styles['font-size']).toBe('48px');
    expect(h1!.styles['color']).toBe('rgb(31, 41, 55)');
    expect(
      result.fonts.some((f) => f.family.replace(/"/g, '') === 'Fixture' && f.status === 'loaded'),
    ).toBe(true);
    expect(result.links).toContain(`${server.url}/about.html`);
    expect(result.dynamicHints).toEqual([]);
    expect(result.pageHeight).toBeGreaterThan(900);
    expect(result.dom).toContain('<h1>');
    expect(result.dom).not.toContain('<script');
    await page.close();
  });

  it('descends through an app shell with no main and finds the sections inside it', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${server.url}/app.html`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const result = await page.evaluate(extractPage, {
      styleProps: STYLE_PROPS,
      minSectionHeight: 80,
      hintMaxViewports: MASK_HINT_MAX_VIEWPORTS,
    });
    expect(result.sections.map((s) => s.role)).toEqual([
      'header',
      'hero',
      'features',
      'section',
      'form',
      'footer',
    ]);
    expect(result.sections[1]!.path).toBe(
      'body>div:nth-of-type(1)>div:nth-of-type(1)>section:nth-of-type(1)',
    );
    expect(result.sections[4]!.heading).toBe('Contact us');
    // the mobile-only note is display:none at this width: not a text block, not a styled element
    expect(result.text.some((t) => t.text === 'Swipe for more')).toBe(false);
    expect(result.text.some((t) => t.text === 'This form is protected by reCAPTCHA.')).toBe(true);
    await page.close();
  });

  it('sees the mobile-only note and loses the wide-only section at a phone width', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${server.url}/app.html`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const result = await page.evaluate(extractPage, {
      styleProps: STYLE_PROPS,
      minSectionHeight: 80,
      hintMaxViewports: MASK_HINT_MAX_VIEWPORTS,
    });
    expect(result.sections.map((s) => s.role)).toEqual([
      'header',
      'hero',
      'features',
      'form',
      'footer',
    ]);
    expect(result.text.some((t) => t.text === 'Swipe for more')).toBe(true);
    await page.close();
  });

  it('masks a cross-origin iframe and not a same-origin one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-iframes-'));
    await fs.writeFile(path.join(dir, 'inner.html'), '<p>inner</p>');
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<main><section style="height:400px"><iframe src="/inner.html" width="200" height="100"></iframe>' +
        `<iframe src="${server.url}/about.html" width="300" height="150"></iframe></section></main>`,
    );
    // a second server is a second origin: the fixture server's about page is cross-origin here
    const other = await serveStatic(dir);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${other.url}/`, { waitUntil: 'load' });
      const result = await page.evaluate(extractPage, {
        styleProps: STYLE_PROPS,
        minSectionHeight: 80,
        hintMaxViewports: MASK_HINT_MAX_VIEWPORTS,
      });
      expect(result.dynamicHints).toHaveLength(1);
      // chromium's default UA stylesheet gives an iframe a 2px inset border on every side, so
      // getBoundingClientRect (what rect() reports) is 4px wider than the width attribute
      expect(result.dynamicHints[0]!.width).toBe(304);
    } finally {
      await page.close();
      await other.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('masks a carousel, whose timer is slower than the rest shots can span', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-carousel-'));
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<main><section style="height:400px"><h1>Slides</h1>' +
        '<div class="carousel" style="width:300px;height:200px">one</div></section></main>',
    );
    const carousel = await serveStatic(dir);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${carousel.url}/`, { waitUntil: 'load' });
      const result = await page.evaluate(extractPage, {
        styleProps: STYLE_PROPS,
        minSectionHeight: 80,
        hintMaxViewports: MASK_HINT_MAX_VIEWPORTS,
      });
      expect(result.dynamicHints).toHaveLength(1);
      expect(result.dynamicHints[0]).toMatchObject({ width: 300, height: 200 });
    } finally {
      await page.close();
      await carousel.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('stops descending at a wrapper that is itself a landmark', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-landmark-'));
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<body><div id="root"><section class="hero" style="padding:100px 0"><h1>Only</h1><p>one section</p></section></div></body>',
    );
    const one = await serveStatic(dir);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${one.url}/`, { waitUntil: 'load' });
      const result = await page.evaluate(extractPage, {
        styleProps: STYLE_PROPS,
        minSectionHeight: 80,
        hintMaxViewports: MASK_HINT_MAX_VIEWPORTS,
      });
      // the walk descends through #root and stops at the section: the section is the unit,
      // not its heading and paragraph (both shorter than minSectionHeight, so a walk that went
      // one level too far would find nothing at all)
      expect(result.sections.map((s) => s.path)).toEqual([
        'body>div:nth-of-type(1)>section:nth-of-type(1)',
      ]);
      expect(result.sections[0]!.heading).toBe('Only');
    } finally {
      await page.close();
      await one.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('passes over a dynamic hint that is larger than the bound, and keeps one that is not', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-hint-'));
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<body><div class="carousel" style="height:3000px"><main><section style="height:200px"><h1>Wrapped</h1></section>' +
        '<div class="carousel" style="height:300px">slides</div><video style="display:block;width:100%;height:900px"></video></main></div></body>',
    );
    const one = await serveStatic(dir);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${one.url}/`, { waitUntil: 'load' });
      const result = await page.evaluate(extractPage, {
        styleProps: STYLE_PROPS,
        minSectionHeight: 80,
        hintMaxViewports: MASK_HINT_MAX_VIEWPORTS,
      });
      // the 3000px wrapper is 3.3 viewports and would mask the page; the slides and the
      // one-viewport video are hints
      expect(result.dynamicHints.map((h) => h.height).sort((a, b) => a - b)).toEqual([300, 900]);
    } finally {
      await page.close();
      await one.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
