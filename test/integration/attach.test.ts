import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { serveStatic } from '../helpers/serve';
import { openSession } from '../../src/capture/session';
import { explore } from '../../src/capture/explore';
import { captureAll } from '../../src/capture/capture-all';
import { loadManifest, readJson } from '../../src/pack/io';
import { PackPaths, UNIT_FILES } from '../../src/pack/paths';
import { PageMetaSchema } from '../../src/pack/schemas';
import { readPng } from '../../src/pack/image';

/** a port nothing listens on right now: bind to 0, read it back, release it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

let server: Awaited<ReturnType<typeof serveStatic>>;
let launched: Browser;
let port: number;
const tmpDirs: string[] = [];

async function tmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  port = await freePort();
  // the chrome a user would start by hand with --remote-debugging-port, headless here
  launched = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
});
afterAll(async () => {
  await launched.close();
  await server.close();
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('capture --attach', () => {
  it("captures over cdp with the attached chrome's own pixel ratio and no emulation", async () => {
    const root = await tmp('site-pack-attach-');
    const planner = await openSession({});
    try {
      await explore({
        root,
        url: `${server.url}/about.html`,
        depth: 0,
        scope: [],
        session: planner,
      });
    } finally {
      await planner.close();
    }
    const session = await openSession({ attach: `http://127.0.0.1:${port}` });
    try {
      expect(session.attached).toEqual({ endpoint: `http://127.0.0.1:${port}`, scale: 1 });
      const r = await captureAll({ root, session });
      expect(r.captured).toEqual(['page:about']);
    } finally {
      await session.close();
    }
    expect(launched.isConnected()).toBe(true);

    const m = await loadManifest(root);
    expect(m.capture.attach).toBe(true);
    expect(m.viewports.mobile).toMatchObject({ width: 390, scale: 1, mobile: false });
    expect(m.viewports.desktop).toMatchObject({ width: 1440, scale: 1, mobile: false });
    const dir = new PackPaths(root).pageDir('about');
    const mobile = await readPng(path.join(dir, 'mobile', UNIT_FILES.full));
    expect(mobile.width).toBe(390);
    const desktop = await readPng(path.join(dir, 'desktop', UNIT_FILES.full));
    expect(desktop.width).toBe(1440);
    const meta = await readJson(PageMetaSchema, path.join(dir, UNIT_FILES.meta));
    expect(meta.title).toBe('About Fixture Co');
    // nothing is recorded here: recordVideo is a context option, and the attached chrome's
    // context is the user's own, already open. the pack says so rather than leaving it null
    expect(meta.motion.desktop).toMatchObject({
      video: null,
      segments: [],
      framesKept: false,
      note: expect.stringContaining(
        "attached session: playwright records video per browser context, and the attached chrome's context is the user's own; nothing was recorded",
      ),
    });
  });

  it('names --attach in the question a challenge page leaves behind', async () => {
    const dir = await tmp('challenge-');
    await fs.writeFile(
      path.join(dir, 'index.html'),
      '<html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing the site.</p></body></html>',
    );
    const blocked = await serveStatic(dir);
    const session = await openSession({});
    try {
      const root = await tmp('site-pack-');
      await explore({ root, url: `${blocked.url}/`, depth: 0, scope: [], session });
      await captureAll({ root, session });
      const question = (await loadManifest(root)).units['page:index']!.question ?? '';
      expect(question).toMatch(/--remote-debugging-port=9222/);
      expect(question).toMatch(/--attach http:\/\/127\.0\.0\.1:9222/);
      expect(question).toMatch(/--headed --profile/);
    } finally {
      await session.close();
      await blocked.close();
    }
  });

  it('discovers the same states through the attached chrome, with masks at its own scale', async () => {
    // with masks cut at the launched desktop scale (2) on a scale-1 attached page, the live
    // counter would sit unmasked and every trigger would read as a state (hover-nav-about,
    // hover-nav-fixture-co ...); the list must be exactly the seven the launched session finds
    const root = await tmp('site-pack-attach-explore-');
    const session = await openSession({ attach: `http://127.0.0.1:${port}` });
    try {
      const m = await explore({ root, url: `${server.url}/`, depth: 0, scope: [], session });
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
      expect(m.units['state:index/menu-menu-open']!.reachable).toEqual(['mobile']);
    } finally {
      await session.close();
    }
  }, 300_000);
});
