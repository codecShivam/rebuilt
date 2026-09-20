import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../helpers/serve';
import { openPage, openSession, type Session } from '../../src/capture/session';
import { explore } from '../../src/capture/explore';
import { captureAll } from '../../src/capture/capture-all';
import { settle } from '../../src/capture/settle';
import { discoverStates } from '../../src/capture/states';
import { DEFAULT_VIEWPORTS } from '../../src/pack/defaults';
import { loadManifest, newManifest, readJson, saveManifest } from '../../src/pack/io';
import { PackPaths, UNIT_FILES } from '../../src/pack/paths';
import { PageMetaSchema } from '../../src/pack/schemas';

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

describe('explore and capture', () => {
  it('plans the reachable pages and their states, and captures the pages with section units', async () => {
    const root = await tmp('site-pack-');
    const m = await explore({ root, url: `${server.url}/`, depth: 1, scope: [], session });
    const pages = Object.keys(m.units)
      .filter((id) => id.startsWith('page:'))
      .sort();
    expect(pages).toEqual(['page:about', 'page:index']);
    expect(m.units['page:about']!.status).toBe('planned');
    expect(m.units['page:about']!.url).toBe(`${server.url}/about.html`);

    const states = Object.keys(m.units)
      .filter((id) => id.startsWith('state:'))
      .sort();
    expect(states).toEqual([
      'state:index/accordion-can-i-cancel-open',
      'state:index/accordion-do-you-store-data-open',
      'state:index/accordion-is-it-accurate-open',
      'state:index/hover-nav-products',
      'state:index/menu-menu-open',
      'state:index/menu-products-open',
      'state:index/modal-talk-to-us',
    ]);
    const modal = m.units['state:index/modal-talk-to-us']!;
    expect(modal).toMatchObject({
      kind: 'state',
      status: 'planned',
      url: `${server.url}/`,
      dependsOn: ['page:index'],
    });
    expect(modal.actions).toEqual([
      {
        kind: 'click',
        target: {
          role: { role: 'button', name: 'Talk to us' },
          text: 'Talk to us',
          css: '#open-modal',
        },
        value: null,
        input: null,
        scroll: null,
      },
    ]);
    expect(m.units['state:index/hover-nav-products']!.actions![0]!.kind).toBe('hover');
    // hovering the About link changes nothing, so it is not a state; about.html has no triggers
    expect(states.some((id) => id.includes('about'))).toBe(false);
    // the hamburger is shown below 600px only, so only the mobile pass reaches its state; the
    // others are reachable at both widths (a hover menu works on a phone-sized window too)
    expect(m.units['state:index/menu-menu-open']).toMatchObject({
      reachable: ['mobile'],
      dependsOn: ['page:index'],
    });
    expect(m.units['state:index/menu-menu-open']!.actions![0]!.target?.role).toEqual({
      role: 'button',
      name: 'Menu',
    });
    expect(m.units['state:index/modal-talk-to-us']!.reachable).toEqual(['mobile', 'desktop']);
    expect(m.units['state:index/hover-nav-products']!.reachable).toEqual(['mobile', 'desktop']);

    const result = await captureAll({ root, session });
    expect(result.captured).toContain('page:about');
    expect(result.captured).toContain('page:index');
    const after = await loadManifest(root);
    expect(after.units['page:index']!.status).toBe('captured');
    expect(after.units['page:index#s02-hero-know-before-you-go']).toMatchObject({
      kind: 'section',
      status: 'captured',
      dependsOn: [],
    });
    expect(after.units['page:index']!.dependsOn).toContain(
      'page:index#s02-hero-know-before-you-go',
    );
    // a state is captured at the viewports that reach it and nowhere else
    expect(after.units['state:index/menu-menu-open']!.status).toBe('captured');
    const drawer = new PackPaths(root).stateDir('index', 'menu-menu-open');
    await expect(fs.stat(path.join(drawer, 'mobile', UNIT_FILES.full))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(drawer, 'desktop'))).rejects.toThrow();
  }, 600_000);

  it('keeps a below-the-fold trigger that changes nothing out of the states', async () => {
    // every trigger on shape.html sits past the first screen, so playwright scrolls to reach
    // it. only the accordion actually changes the page: the footer links have no hover style,
    // the toggle has no handler, one button navigates 200 ms late and one link opens a tab.
    const root = await tmp('site-pack-shape-');
    const m = await explore({
      root,
      url: `${server.url}/shape.html`,
      depth: 0,
      scope: [],
      session,
    });
    const states = Object.keys(m.units)
      .filter((id) => id.startsWith('state:'))
      .sort();
    expect(states).toEqual(['state:shape/accordion-below-the-fold-open']);
    // the late navigation and the new tab did not stop the walk either
    expect(m.units['page:shape']!.status).toBe('planned');
  }, 300_000);

  it('does not refetch pages the manifest already knows', async () => {
    const root = await tmp('site-pack-');
    await explore({ root, url: `${server.url}/`, depth: 1, scope: [], session, states: false });
    server.hits.length = 0;
    await explore({ root, url: `${server.url}/`, depth: 1, scope: [], session, states: false });
    expect(server.hits.filter((h) => h === '/about.html')).toEqual([]);
    expect(server.hits.filter((h) => h === '/')).toHaveLength(1);
  });

  it('stays inside the scope globs', async () => {
    const narrow = await explore({
      root: await tmp('site-pack-'),
      url: `${server.url}/`,
      depth: 1,
      scope: ['/nothing/**'],
      session,
      states: false,
    });
    expect(Object.keys(narrow.units)).toEqual(['page:index']);
    const wide = await explore({
      root: await tmp('site-pack-'),
      url: `${server.url}/`,
      depth: 1,
      scope: ['/about*'],
      session,
      states: false,
    });
    expect(Object.keys(wide.units).sort()).toEqual(['page:about', 'page:index']);
  });

  it('marks a challenge page blocked instead of capturing it', async () => {
    const dir = await tmp('challenge-');
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing the site.</p></body></html>',
    );
    const blocked = await serveStatic(dir);
    try {
      const root = await tmp('site-pack-');
      await explore({ root, url: `${blocked.url}/`, depth: 0, scope: [], session });
      const result = await captureAll({ root, session });
      expect(result.blocked).toEqual(['page:index']);
      const m = await loadManifest(root);
      expect(m.units['page:index']!.status).toBe('blocked');
      expect(m.units['page:index']!.blockedReason).toBe('blocked_by_site');
    } finally {
      await blocked.close();
    }
  });

  it('blocks a dead link and captures the pages around it', async () => {
    const dir = await tmp('site-dead-link-');
    await fs.cp(path.resolve('test/fixtures/site'), dir, { recursive: true });
    const index = await fs.readFile(path.join(dir, 'index.html'), 'utf8');
    await fs.writeFile(
      path.join(dir, 'index.html'),
      index.replace('</main>', '  <p><a href="/missing.html">Missing</a></p>\n  </main>'),
    );
    const dead = await serveStatic(dir);
    try {
      const root = await tmp('site-pack-');
      const m = await explore({
        root,
        url: `${dead.url}/`,
        depth: 1,
        scope: [],
        session,
        states: false,
      });
      expect(m.units['page:missing']).toMatchObject({
        kind: 'page',
        status: 'blocked',
        blockedReason: 'http_404',
        url: `${dead.url}/missing.html`,
      });
      expect(m.units['page:missing']!.question).toContain('missing.html');
      expect(m.units['page:index']!.status).toBe('planned');
      const result = await captureAll({ root, session });
      expect(result.captured).toContain('page:index');
      expect(result.blocked).toEqual([]);
    } finally {
      await dead.close();
    }
  }, 300_000);

  it('takes the rest-shot span from its caller, and explore takes it from the manifest', async () => {
    // about.html has no live region and no state: the span only shows in how long the masks take
    const opened = await openPage(session, DEFAULT_VIEWPORTS.desktop);
    try {
      await opened.page.goto(`${server.url}/about.html`, { waitUntil: 'load' });
      await settle(opened.page);
      const quick = Date.now();
      const fast = await discoverStates(
        opened.page,
        `${server.url}/about.html`,
        DEFAULT_VIEWPORTS.desktop,
        { shots: 2, gap: 10 },
      );
      const fastMs = Date.now() - quick;
      await opened.page.goto(`${server.url}/about.html`, { waitUntil: 'load' });
      await settle(opened.page);
      const slow = Date.now();
      const same = await discoverStates(
        opened.page,
        `${server.url}/about.html`,
        DEFAULT_VIEWPORTS.desktop,
        { shots: 2, gap: 3000 },
      );
      expect(Date.now() - slow).toBeGreaterThanOrEqual(3000);
      expect(Date.now() - slow).toBeGreaterThan(fastMs);
      expect(same).toEqual(fast);
    } finally {
      await opened.release();
    }
    const root = await tmp('site-pack-span-');
    const m = newManifest({ host: '127.0.0.1', sourceUrl: `${server.url}/about.html` });
    m.capture.dynamicShots = 2;
    m.capture.dynamicGap = 3000;
    await saveManifest(root, m);
    const started = Date.now();
    const explored = await explore({
      root,
      url: `${server.url}/about.html`,
      depth: 0,
      scope: [],
      session,
    });
    // two passes (desktop and mobile), one three-second span each
    expect(Date.now() - started).toBeGreaterThanOrEqual(6000);
    expect(explored.capture).toMatchObject({ dynamicShots: 2, dynamicGap: 3000 });
  }, 120_000);

  it('replays a state with the actions its own viewport recorded', async () => {
    const root = await tmp('site-pack-per-vp-');
    await explore({ root, url: `${server.url}/`, depth: 0, scope: [], session });
    const m = await loadManifest(root);
    const drawer = m.units['state:index/menu-menu-open']!;
    expect(drawer.reachable).toEqual(['mobile']);
    expect(drawer.actionsByViewport).toBeUndefined();
    // the desktop pass found the products menu with the same trigger: no per-viewport actions
    expect(m.units['state:index/menu-products-open']!.actionsByViewport).toBeUndefined();
    // a hand-edited state: the shared actions point at nothing, the mobile actions at the hamburger
    const hamburger = drawer.actions!;
    drawer.actions = [
      {
        kind: 'click',
        target: { role: { role: 'button', name: 'Nowhere' }, text: 'Nowhere', css: '#nowhere' },
        value: null,
        input: null,
        scroll: null,
      },
    ];
    drawer.actionsByViewport = { mobile: hamburger };
    for (const id of Object.keys(m.units))
      if (id !== 'state:index/menu-menu-open' && id !== 'page:index') delete m.units[id];
    m.units['page:index']!.dependsOn = [];
    await saveManifest(root, m);
    const r = await captureAll({ root, session });
    expect(r.blocked).toEqual([]);
    expect(r.captured).toContain('state:index/menu-menu-open');
    const meta = await readJson(
      PageMetaSchema,
      path.join(new PackPaths(root).stateDir('index', 'menu-menu-open'), UNIT_FILES.meta),
    );
    expect(meta.reachedBy).toBe('replay');
  }, 300_000);

  it('stops instead of replacing a manifest.json that fails its schema', async () => {
    const root = await tmp('site-pack-');
    const manifestPath = path.join(root, 'manifest.json');
    const original = JSON.stringify({ host: 'x' }, null, 2);
    await fs.writeFile(manifestPath, original);
    await expect(
      explore({ root, url: `${server.url}/`, depth: 0, scope: [], session }),
    ).rejects.toThrow(/manifest\.json.*schema failure/s);
    const raw = await fs.readFile(manifestPath, 'utf8');
    expect(raw).toBe(original);
    expect(raw).toContain('"host": "x"');
  });
});
