import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { captureAll } from '../../src/capture/capture-all';
import { explore } from '../../src/capture/explore';
import { openSession } from '../../src/capture/session';
import { fetchSnapshot, SNAPSHOT_FILES } from '../../src/orchestrate/scaffold/snapshot';
import { isUp, startDevServer } from '../../src/orchestrate/scaffold/dev-server';
import { formatProject, scaffoldProject } from '../../src/orchestrate/scaffold/scaffold';
import { verifyUnit } from '../../src/verify/verify';
import { loadManifest, saveManifest } from '../../src/pack/io';
import { PackPaths } from '../../src/pack/paths';
import { serveStatic } from '../helpers/serve';
import { installCached } from '../helpers/scaffold-cache';

const require = createRequire(import.meta.url);

const FIXTURE = path.resolve('test/fixtures/scaffold/nextjs-app');
/** persistent across runs: the tarball is fetched once, node_modules installed once */
const CACHE = path.join(os.tmpdir(), 'site-scaffold-cache');
const env = { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}` };
let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-scaffold-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('scaffoldProject', () => {
  it('installs, type-checks, lints, serves the placeholder on a free port, and stops', async () => {
    const out = path.join(root, 'blank');
    const r = await scaffoldProject({
      out,
      name: 'blank-rebuild',
      source: FIXTURE,
      install: false,
    });
    expect(r.project).toBe(out);
    await installCached(out);
    await formatProject(out, env);
    const tsc = await execa('npx', ['tsc', '--noEmit'], { cwd: out, env, reject: false });
    expect(tsc.exitCode, tsc.stdout + tsc.stderr).toBe(0);
    const lint = await execa('npx', ['next', 'lint', '--max-warnings', '0'], {
      cwd: out,
      env,
      reject: false,
    });
    expect(lint.exitCode, lint.stdout + lint.stderr).toBe(0);
    const dev = await startDevServer({ project: out, log: path.join(root, 'dev.log'), env });
    try {
      const res = await fetch(`${dev.url}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('data-section="placeholder"');
      expect(html).toContain('site scaffold');
    } finally {
      await dev.stop();
    }
    expect(await isUp(`${dev.url}/`)).toBe(false);
    await expect(fs.readFile(dev.log, 'utf8')).resolves.toMatch(/Ready|ready/);
    await expect(
      scaffoldProject({ out, name: 'x', source: FIXTURE, install: false }),
    ).rejects.toThrow(/already has a package.json/);
  }, 900_000);
});

describe('the pinned commit', () => {
  it('fetches the tarball once into the cache, and its files are the vendored bytes', async (ctx) => {
    let tree: string;
    try {
      tree = await fetchSnapshot({ cacheDir: path.join(CACHE, 'snapshot') });
    } catch (err) {
      const message =
        err instanceof Error
          ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`
          : String(err);
      if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(message)) {
        ctx.skip();
        return;
      }
      throw err;
    }
    for (const rel of SNAPSHOT_FILES) {
      expect(await fs.readFile(path.join(tree, rel)), rel).toEqual(
        await fs.readFile(path.join(FIXTURE, rel)),
      );
    }
    // the demo is in the snapshot and never in the scaffold
    await expect(fs.stat(path.join(tree, 'mock-server.ts'))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(tree, 'src/features/auth'))).resolves.toBeTruthy();
    // a second call is a stat, not a fetch: a fetch that would throw is never called
    const again = await fetchSnapshot({
      cacheDir: path.join(CACHE, 'snapshot'),
      fetch: () => Promise.reject(new Error('no network for you')),
    });
    expect(again).toBe(tree);
  }, 300_000);
});

describe('scaffoldProject from a pack', () => {
  it('generates the features, routes, shared chrome, tokens, fonts and assets, and serves a rebuild verify can measure', async () => {
    const server = await serveStatic(path.resolve('test/fixtures/site'));
    const session = await openSession({});
    const pack = await fs.mkdtemp(path.join(os.tmpdir(), 'site-pack-scaffold-'));
    const out = path.join(root, 'fixture-co');
    try {
      await explore({
        root: pack,
        url: `${server.url}/`,
        depth: 1,
        scope: [],
        session,
        states: false,
      });
      await captureAll({ root: pack, session });
      // two pages whose urls are nested, so their feature dirs are the slugs slugFromUrl
      // builds from more than one path segment: a doubled hyphen, and a leading digit. the
      // fixture twins have only `/` and `/about.html`, so nothing here saw one before, and
      // the generated eslint config has to admit the dirs the generator itself writes or
      // `next lint --max-warnings 0` fails after every builder and the page blocks
      const paths = new PackPaths(pack);
      const m = await loadManifest(pack);
      const at = new Date().toISOString();
      const base = { status: 'captured' as const, dependsOn: [], rounds: 0, updatedAt: at };
      for (const [slug, url] of [
        ['blog--hello', `${server.url}/blog/hello`],
        ['2024--report', `${server.url}/2024/report`],
      ]) {
        await fs.cp(paths.pageDir('index'), paths.pageDir(slug!), { recursive: true });
        m.units[`page:${slug}`] = { kind: 'page', url, ...base };
        for (const s of ['s01-header', 's02-hero-know-before-you-go']) {
          m.units[`page:${slug}#${s}`] = { kind: 'section', ...base };
        }
      }
      await saveManifest(pack, m);
      const r = await scaffoldProject({
        out,
        name: 'fixture-co-rebuild',
        source: FIXTURE,
        root: pack,
        install: false,
      });
      const g = r.generated!;
      expect(g.features).toEqual(['2024--report', 'about', 'blog--hello', 'index']);
      expect(g.layouts).toEqual([
        'src/components/layouts/site-footer.tsx',
        'src/components/layouts/site-header.tsx',
      ]);
      expect(g.routes).toEqual([
        'src/app/2024/report/page.tsx',
        'src/app/about.html/page.tsx',
        'src/app/blog/hello/page.tsx',
        'src/app/page.tsx',
      ]);
      expect(g.components).toContain(
        'src/features/index/components/s02-hero-know-before-you-go.tsx',
      );
      // shared chrome is a layout, and the section unit still has the file the mapping names
      expect(g.components).toContain('src/features/index/components/s01-header.tsx');
      const hero = await fs.readFile(
        path.join(out, 'src/features/index/components/s02-hero-know-before-you-go.tsx'),
        'utf8',
      );
      expect(hero).toContain('data-section="s02-hero-know-before-you-go"');
      expect(hero).toContain('<h1>Know before you go</h1>');
      const header = await fs.readFile(
        path.join(out, 'src/features/index/components/s01-header.tsx'),
        'utf8',
      );
      expect(header).toContain("import { SiteHeader } from '@/components/layouts/site-header';");
      expect(header).toContain('return <SiteHeader sectionId="s01-header" />;');
      const route = await fs.readFile(path.join(out, 'src/app/page.tsx'), 'utf8');
      expect(route).toContain(
        "import { S01Header } from '@/features/index/components/s01-header';",
      );
      expect(route).toContain(
        "import { S06Footer } from '@/features/index/components/s06-footer';",
      );
      expect(route).not.toContain('@/components/layouts');
      expect(route).toContain('<S03FeaturesEverythingYouNeed />');
      // the generated tailwind config requires its one plugin by name, so it is read with the
      // project's own node_modules in place
      await installCached(out);
      const tailwind = require(path.join(out, 'tailwind.config.cjs'));
      expect(tailwind.theme.extend.colors['pack-2563eb']).toBe('#2563eb');
      expect(tailwind.theme.extend.fontFamily.fixture).toEqual(['Fixture']);
      expect(tailwind.theme.extend.keyframes.pulse['50%']).toEqual({ transform: 'scale(1.08)' });
      expect(tailwind.theme.extend.keyframes.fadeIn['100%']).toEqual({
        opacity: '1',
        transform: 'none',
      });
      expect(tailwind.theme.extend.animation.pulse).toMatch(/^pulse 2s ease-in-out/);
      expect(g.fonts).toHaveLength(2);
      const fonts = await fs.readFile(path.join(out, 'src/styles/fonts.css'), 'utf8');
      expect(fonts.match(/@font-face/g)).toHaveLength(2);
      expect(fonts).toContain("font-family: 'Fixture';");
      expect(fonts).toContain('font-weight: 700;');
      for (const f of g.fonts) await expect(fs.stat(path.join(out, f))).resolves.toBeTruthy();
      expect(g.assets.some((a) => a.endsWith('hero.png'))).toBe(true);
      const eslint = require(path.join(out, '.eslintrc.cjs'));
      expect(
        eslint.overrides[0].rules['import/no-restricted-paths'][1].zones.map(
          (z: { target: unknown }) => z.target,
        ),
      ).toEqual([
        './src/features/2024--report',
        './src/features/about',
        './src/features/blog--hello',
        './src/features/index',
        './src/features',
        ['./src/components', './src/hooks', './src/lib', './src/types', './src/utils'],
      ]);

      // before the format, not after: the generated text is what has to lint clean, and the
      // two nested-url features above are dirs check-file's KEBAB_CASE would have refused
      await expect(fs.stat(path.join(out, 'src/features/2024--report'))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(out, 'src/features/blog--hello'))).resolves.toBeTruthy();
      const lint = await execa('npx', ['next', 'lint', '--max-warnings', '0'], {
        cwd: out,
        env,
        reject: false,
      });
      expect(lint.exitCode, lint.stdout + lint.stderr).toBe(0);
      await formatProject(out, env);
      const tsc = await execa('npx', ['tsc', '--noEmit'], { cwd: out, env, reject: false });
      expect(tsc.exitCode, tsc.stdout + tsc.stderr).toBe(0);
      const dev = await startDevServer({ project: out, log: path.join(root, 'dev-pack.log'), env });
      try {
        const home = await (await fetch(`${dev.url}/`)).text();
        expect(home).toContain('data-section="s01-header"');
        expect(home).toContain('data-section="s02-hero-know-before-you-go"');
        expect(home).toContain('data-section="s06-footer"');
        const about = await fetch(`${dev.url}/about.html`);
        expect(about.status).toBe(200);
        expect(await about.text()).toContain('data-section=');
        // the stub is found by its data-section and measured; it fails on pixels, never on `missing`
        const v = await verifyUnit({
          root: pack,
          unitId: 'page:index#s02-hero-know-before-you-go',
          target: dev.url,
          session,
        });
        expect(v.verdict).toBe('fail');
        expect(v.missing).not.toContain('s02-hero-know-before-you-go');
        expect(v.pixel.desktop!.score).toBeGreaterThan(0.001);
      } finally {
        await dev.stop();
      }
    } finally {
      await session.close();
      await server.close();
      await fs.rm(pack, { recursive: true, force: true });
    }
  }, 900_000);
});
