import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { captureAll } from '../../src/capture/capture-all';
import { explore } from '../../src/capture/explore';
import { openSession, type Session } from '../../src/capture/session';
import { brandProject, DEVIATIONS_FILE, snapshotTree } from '../../src/orchestrate/brand';
import { startDevServer } from '../../src/orchestrate/scaffold/dev-server';
import { formatProject, scaffoldProject } from '../../src/orchestrate/scaffold/scaffold';
import { workerEnv } from '../../src/orchestrate/worker';
import { gateStructure } from '../../src/verify/brand';
import { writeBuiltIndex } from '../helpers/built-fixture';
import { installCached } from '../helpers/scaffold-cache';
import { serveStatic } from '../helpers/serve';

const require = createRequire(import.meta.url);
const bin = path.resolve('bin/site');
const FIXTURE = path.resolve('test/fixtures/scaffold/nextjs-app');
const BRAND = path.resolve('test/fixtures/brand/brand.json');
// bin/site runs `node`, so the node running the tests has to be first on the child's PATH;
// workerEnv takes this session's own claude variables out (src/orchestrate/worker.ts, as
// test/unit/cli.test.ts uses it)
const env = workerEnv({
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
});

let server: Awaited<ReturnType<typeof serveStatic>>;
let session: Session;
let pack: string;
let work: string;
let project: string;
/** every port a dev server of this file ran on, the one the cli started included; none may outlive it */
const ports: number[] = [];

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  session = await openSession({});
  pack = await fs.mkdtemp(path.join(os.tmpdir(), 'site-pack-brand-'));
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'site-brand-'));
  project = path.join(work, 'fixture-co');
  // two pages, no states: index and about, so the shared chrome is a layout and the about page
  // is gated on its stubs alone
  await explore({ root: pack, url: `${server.url}/`, depth: 1, scope: [], session, states: false });
  await captureAll({ root: pack, session });
  await scaffoldProject({
    out: project,
    name: 'fixture-co-rebuild',
    source: FIXTURE,
    root: pack,
    install: false,
  });
  await installCached(project);
  await writeBuiltIndex(project);
  await formatProject(project, env);
}, 600_000);

afterAll(async () => {
  // every step runs before the assertion, so a dev server cannot outlive a failure here
  await session.close();
  await server.close();
  await fs.rm(pack, { recursive: true, force: true });
  await fs.rm(work, { recursive: true, force: true });
  if (ports.length) {
    // npm's own line and next's both carry the port and the host; neither may still be there
    const pattern = `p (${ports.join('|')}) -H 127\\.0\\.0\\.1`;
    const left = await execa('pgrep', ['-f', pattern], { reject: false });
    expect(left.stdout.trim()).toBe('');
  }
});

describe('site brand over the fixture', () => {
  it('applies the sample, keeps tsc and next lint green, passes the gate with normalisation and fails it without, and changes nothing the second time', async () => {
    // the brand phase writes no statuses: transition is the only writer, and it is not in this
    // road at all, so the pack's manifest must come out of both runs byte for byte
    const manifestFile = path.join(pack, 'manifest.json');
    const manifestBefore = await fs.readFile(manifestFile);

    // the no-op negative for the gate: before any brand, the hand-built rebuild is the
    // fixture's own structure, exactly, with no normaliser
    const dev0 = await startDevServer({ project, log: path.join(work, 'dev0.log'), env });
    ports.push(dev0.port);
    try {
      const exact = await gateStructure({ root: pack, target: dev0.url, session, brand: null });
      expect(exact.units.map((u) => [u.unitId, u.findings])).toEqual([
        ['page:about', []],
        ['page:index', []],
      ]);
      expect(exact).toMatchObject({ verdict: 'pass', skipped: [] });
    } finally {
      await dev0.stop();
    }

    // run 1 through bin/site: it starts its own dev server in the project
    const r1 = await execa(bin, ['brand', '--project', project, '--brand', BRAND, '--pack', pack], {
      env,
      extendEnv: false,
      reject: false,
    });
    expect(r1.exitCode, r1.stderr).toBe(0);
    expect(r1.stdout).toContain('page:about: pass');
    expect(r1.stdout).toContain('page:index: pass');
    expect(r1.stdout).toMatch(/report: .*deviations\.md/);
    expect(await fs.readFile(manifestFile)).toEqual(manifestBefore);
    const runs = (await fs.readdir(path.join(pack, 'runs'))).filter((n) => n.startsWith('brand-'));
    expect(runs).toHaveLength(1);
    const devLog = await fs.readFile(path.join(pack, 'runs', runs[0]!, 'dev-server.log'), 'utf8');
    expect(devLog).toMatch(/Ready|ready/);
    const cliPort = /127\.0\.0\.1:(\d+)/.exec(devLog);
    if (cliPort) ports.push(Number(cliPort[1]));

    const report = await fs.readFile(path.join(project, DEVIATIONS_FILE), 'utf8');
    expect(report).toContain('- colour pack-2563eb: #2563eb -> #e11d48');
    expect(report).toContain('- colour pack-111827: #111827 -> #0f172a');
    expect(report).toContain(
      '- family Fixture -> Acme Sans: faces Acme-Regular.woff2 (400 normal), Acme-Bold.woff2 (700 normal)',
    );
    expect(report).toMatch(/- removed .*src\/assets\/fonts\/font-[0-9a-f]+-Fixture-Regular\.woff2/);
    expect(report).toMatch(/- removed .*src\/assets\/fonts\/font-[0-9a-f]+-a1b2c3d4e5\.woff2/);
    expect(report).toMatch(/- src\/assets\/image-[0-9a-f]+-hero\.png <- logo\.png/);
    expect(report).toContain('- Fixture Co -> Acme Ltd: 3');
    expect(report).toContain('- Scanner -> Acme Scan: 1');
    expect(report).toContain('- Monitor -> Acme Watch: 1');
    expect(report).toContain('  - src/components/layouts/site-header.tsx: 3');
    expect(report).toContain('## left for you\n\n- nothing');
    expect(report).toContain('- page:about: pass');
    expect(report).toContain('- page:index: pass');
    expect(report).toContain('verdict: pass');

    // the theme, read with the project's own node_modules in place
    const tailwind = require(path.join(project, 'tailwind.config.cjs'));
    expect(tailwind.theme.extend.colors['pack-2563eb']).toBe('#e11d48');
    expect(tailwind.theme.extend.colors['pack-111827']).toBe('#0f172a');
    expect(tailwind.theme.extend.colors['pack-1f2937']).toBe('#1f2937');
    expect(tailwind.theme.extend.fontFamily.fixture).toEqual(['Acme Sans']);
    expect(tailwind.theme.extend.keyframes.pulse['50%']).toEqual({ transform: 'scale(1.08)' });
    // the faces
    const fontsCss = await fs.readFile(path.join(project, 'src/styles/fonts.css'), 'utf8');
    expect(fontsCss.match(/@font-face/g)).toHaveLength(2);
    expect(fontsCss.match(/font-family: 'Acme Sans';/g)).toHaveLength(2);
    expect(fontsCss).toContain("url('../assets/fonts/Acme-Regular.woff2')");
    expect(fontsCss).toContain("url('../assets/fonts/Acme-Bold.woff2')");
    expect(fontsCss).not.toContain("'Fixture'");
    expect((await fs.readdir(path.join(project, 'src/assets/fonts'))).sort()).toEqual([
      '.gitkeep',
      'Acme-Bold.woff2',
      'Acme-Regular.woff2',
    ]);
    // the logo, under the asset's own name
    const assets = await fs.readdir(path.join(project, 'src/assets'));
    const heroFile = assets.find((n) => n.endsWith('-hero.png'))!;
    expect(await fs.readFile(path.join(project, 'src/assets', heroFile))).toEqual(
      await fs.readFile(path.resolve('test/fixtures/brand/logo.png')),
    );
    // the names, and what they must never touch
    const header = await fs.readFile(
      path.join(project, 'src/components/layouts/site-header.tsx'),
      'utf8',
    );
    for (const word of ['Acme Ltd', 'Acme Scan', 'Acme Watch']) expect(header).toContain(word);
    expect(header).not.toContain('Fixture');
    expect(header).toContain('data-section={sectionId}');
    const hero = await fs.readFile(
      path.join(project, 'src/features/index/components/s02-hero-know-before-you-go.tsx'),
      'utf8',
    );
    expect(hero).toContain('Acme Ltd checks every detail so you never have to guess.');
    expect(hero).toContain('data-section="s02-hero-know-before-you-go"');
    expect(hero).toContain(`import hero from '@/assets/${heroFile}';`);

    // the project after the codemod is still a project
    const tsc = await execa('npx', ['tsc', '--noEmit'], { cwd: project, env, reject: false });
    expect(tsc.exitCode, tsc.stdout + tsc.stderr).toBe(0);
    const lint = await execa('npx', ['next', 'lint', '--max-warnings', '0'], {
      cwd: project,
      env,
      reject: false,
    });
    expect(lint.exitCode, lint.stdout + lint.stderr).toBe(0);

    // run 2, against a server this test starts: nothing to change, the gate passes again, and
    // without normalisation the same server fails on the two branded buttons
    const before = await snapshotTree(project);
    const dev = await startDevServer({ project, log: path.join(work, 'dev2.log'), env });
    ports.push(dev.port);
    try {
      const r2 = await brandProject({
        root: pack,
        project,
        brandFile: BRAND,
        target: dev.url,
        env,
        log: () => {},
      });
      expect(r2.changed).toEqual([]);
      expect(r2.names.counts).toEqual({ 'Fixture Co': 0, Scanner: 0, Monitor: 0 });
      expect(r2.names.files).toEqual({});
      expect(r2.theme.copied).toEqual([]);
      expect(r2.theme.removed).toEqual([]);
      expect(r2.logos.replaced).toEqual([]);
      expect(r2.logos.unchanged).toHaveLength(1);
      expect(r2.leftovers).toEqual([]);
      expect(r2.gate.verdict).toBe('pass');
      expect(await snapshotTree(project)).toEqual(before);
      expect(await fs.readFile(manifestFile)).toEqual(manifestBefore);
      // the second run took a run dir of its own in the pack, and started no server
      expect(
        (await fs.readdir(path.join(pack, 'runs'))).filter((n) => n.startsWith('brand-')),
      ).toHaveLength(2);
      await expect(fs.stat(path.join(pack, 'runs', r2.run, 'dev-server.log'))).rejects.toThrow(
        /ENOENT/,
      );

      const exact = await gateStructure({ root: pack, target: dev.url, session, brand: null });
      expect(exact.verdict).toBe('fail');
      const index = exact.units.find((u) => u.unitId === 'page:index')!;
      expect(index.findings).toEqual([
        { kind: 'button', expected: 'Scanner', actual: '(missing)', where: 's01-header' },
        { kind: 'button', expected: 'Monitor', actual: '(missing)', where: 's01-header' },
      ]);
      // the about page's header has no buttons in the source, so nothing there is missing
      expect(exact.units.find((u) => u.unitId === 'page:about')!.findings).toEqual([]);
    } finally {
      await dev.stop();
    }
  }, 900_000);
});
