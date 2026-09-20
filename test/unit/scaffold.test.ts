import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import { format } from 'prettier';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../helpers/serve';
import {
  fetchSnapshot,
  SNAPSHOT,
  SNAPSHOT_FILES,
  SnapshotError,
  tarballUrl,
  VERBATIM,
} from '../../src/orchestrate/scaffold/snapshot';
import {
  EMPTY_TOKENS,
  eslintConfig,
  GENERATED,
  KEEP_DEPENDENCIES,
  KEEP_DEV_DEPENDENCIES,
  packageJson,
  tailwindConfig,
} from '../../src/orchestrate/scaffold/template';
import {
  freePort,
  isUp,
  PortInUseError,
  startDevServer,
  waitForServer,
} from '../../src/orchestrate/scaffold/dev-server';
import { scaffoldProject } from '../../src/orchestrate/scaffold/scaffold';
import {
  chromeSectionStub,
  chromeStub,
  colourToken,
  fontsCss,
  generateFromPack,
  pruneSnapshot,
  routeFile,
  sectionStub,
  stepStub,
  tokensFrom,
} from '../../src/orchestrate/scaffold/generate';
import { killStaleDevServers } from '../../src/orchestrate/build';
import { processAlive } from '../../src/orchestrate/lock';
import { saveManifest } from '../../src/pack/io';
import { PackPaths } from '../../src/pack/paths';
import type { AnimationsFile, PageMeta, Section } from '../../src/pack/schemas';
import { synthPack, SYNTH_URL } from '../helpers/pack';

export const FIXTURE = path.resolve('test/fixtures/scaffold/nextjs-app');
const require = createRequire(import.meta.url);
let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-scaffold-unit-'));
  // the generated tailwind config requires its one plugin by name. the unit run installs
  // nothing, so the plugin is stubbed above the pruned dir, where node's resolution walks;
  // the integration run loads the real one out of the installed project.
  const stub = path.join(root, 'node_modules', 'tailwindcss-animate');
  await fs.mkdir(stub, { recursive: true });
  await fs.writeFile(
    path.join(stub, 'package.json'),
    '{ "name": "tailwindcss-animate", "version": "0.0.0", "main": "index.cjs" }\n',
  );
  await fs.writeFile(path.join(stub, 'index.cjs'), 'module.exports = { handler: () => {} };\n');
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** a project whose only script is `dev`, plus the hang script the dev-server tests run */
async function devProject(name: string, script: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name, version: '0.0.0', private: true, scripts: { dev: script } }, null, 2)}\n`,
  );
  // holds the event loop and never answers http, so waitForServer has to time out on it
  await fs.writeFile(
    path.join(dir, 'hang.cjs'),
    "require('node:fs').writeFileSync(process.argv[2], String(process.pid));\n" +
      'setInterval(() => {}, 1000);\n',
  );
  // answers, and says in its log what next 14 says when the port it wanted was taken
  await fs.writeFile(
    path.join(dir, 'moved.cjs'),
    "const http = require('node:http');\n" +
      "const port = Number(process.argv[process.argv.indexOf('-p') + 1]);\n" +
      'console.log(`Port ${port} is in use, trying ${port + 1} instead`);\n' +
      "http.createServer((_req, res) => res.writeHead(200).end('ok')).listen(port, '127.0.0.1');\n",
  );
  return dir;
}

/** a signalled process leaves a moment after the one that was signalled with it */
async function waitGone(pid: number): Promise<void> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** every file under dir, relative posix paths, sorted; node_modules and .next left out */
export async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

describe('the pinned snapshot', () => {
  it('names the commit and the tarball, and vendors exactly the files the prune reads', async () => {
    expect(SNAPSHOT).toEqual({
      repo: 'alan2207/bulletproof-react',
      commit: '79710ebadede09623d11e0ab702eff30f237df5c',
      subdir: 'apps/nextjs-app',
    });
    expect(tarballUrl()).toBe(
      'https://codeload.github.com/alan2207/bulletproof-react/tar.gz/79710ebadede09623d11e0ab702eff30f237df5c',
    );
    expect(await listFiles(FIXTURE)).toEqual([...SNAPSHOT_FILES].sort());
    expect(SNAPSHOT_FILES).toEqual([...VERBATIM, 'package.json']);
  });

  it('prunes the snapshot into the bulletproof shape without the demo, the mocks or the test stack', async () => {
    const dest = path.join(root, 'pruned');
    await pruneSnapshot(FIXTURE, dest, { name: 'x-rebuild' });
    expect(await listFiles(dest)).toEqual([
      '.eslintrc.cjs',
      '.gitignore',
      '.prettierignore',
      '.prettierrc',
      'next-env.d.ts',
      'next.config.mjs',
      'package.json',
      'postcss.config.cjs',
      'public/robots.txt',
      'src/app/layout.tsx',
      'src/app/not-found.tsx',
      'src/app/page.tsx',
      'src/app/provider.tsx',
      'src/assets/fonts/.gitkeep',
      'src/components/errors/main.tsx',
      'src/components/layouts/.gitkeep',
      'src/components/ui/.gitkeep',
      'src/config/paths.ts',
      'src/features/.gitkeep',
      'src/hooks/use-disclosure.ts',
      'src/lib/.gitkeep',
      'src/styles/fonts.css',
      'src/styles/globals.css',
      'src/testing/.gitkeep',
      'src/types/.gitkeep',
      'src/utils/cn.ts',
      'tailwind.config.cjs',
      'tsconfig.json',
    ]);
    for (const rel of VERBATIM) {
      expect(await fs.readFile(path.join(dest, rel)), rel).toEqual(
        await fs.readFile(path.join(FIXTURE, rel)),
      );
    }
    const pkg = JSON.parse(await fs.readFile(path.join(dest, 'package.json'), 'utf8'));
    const snapshot = JSON.parse(await fs.readFile(path.join(FIXTURE, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('x-rebuild');
    expect(pkg.scripts).toEqual({
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      lint: 'next lint',
      'check-types': 'tsc --noEmit',
    });
    expect(Object.keys(pkg.dependencies)).toEqual(KEEP_DEPENDENCIES);
    expect(Object.keys(pkg.devDependencies)).toEqual(KEEP_DEV_DEPENDENCIES);
    for (const [k, v] of Object.entries(pkg.dependencies))
      expect(v, k).toBe(snapshot.dependencies[k]);
    for (const [k, v] of Object.entries(pkg.devDependencies))
      expect(v, k).toBe(snapshot.devDependencies[k]);
    expect(JSON.stringify(pkg)).not.toMatch(/msw|storybook|vitest|playwright|react-query|zustand/);
    expect(await fs.readFile(path.join(dest, 'next.config.mjs'), 'utf8')).toContain(
      'unoptimized: true',
    );
    const eslint = require(path.join(dest, '.eslintrc.cjs'));
    const ts = eslint.overrides[0];
    expect(ts.extends).toContain('plugin:tailwindcss/recommended');
    expect(ts.extends).not.toContain('plugin:vitest/legacy-recommended');
    expect(ts.rules['import/no-restricted-paths'][1].zones).toHaveLength(2);
    expect(eslint.overrides[1].plugins).toEqual(['check-file']);
    expect(eslint.overrides[1].rules['check-file/filename-naming-convention'][1]).toEqual({
      '**/*.{ts,tsx}': 'KEBAB_CASE',
    });
    // not KEBAB_CASE for the feature dirs: check-file reads that as a leading letter and
    // single hyphens, and slugFromUrl writes a leading digit and doubled hyphens
    expect(eslint.overrides[1].rules['check-file/folder-naming-convention'][1]).toEqual({
      '!(src/app)/**/*': '+([a-z0-9])*(-*([a-z0-9]))',
      '!(**/__tests__)/**/*': 'KEBAB_CASE',
    });
    const tailwind = require(path.join(dest, 'tailwind.config.cjs'));
    expect(tailwind.content).toEqual(['./src/**/*.{js,ts,jsx,tsx}']);
    expect(tailwind.theme.extend).toEqual({
      colors: {},
      fontFamily: {},
      keyframes: {},
      animation: {},
    });
    expect(tailwind.plugins).toHaveLength(1);
    expect(await fs.readFile(path.join(dest, 'src/app/page.tsx'), 'utf8')).toContain(
      'data-section="placeholder"',
    );
    expect(await fs.readFile(path.join(dest, 'src/app/layout.tsx'), 'utf8')).toContain(
      "title: 'x-rebuild'",
    );
  });

  it('wires the error boundary in the provider, in the shape prettier prints', async () => {
    const provider = GENERATED['src/app/provider.tsx']!;
    expect(provider).toContain("import { MainErrorFallback } from '@/components/errors/main';");
    expect(provider).toContain('static getDerivedStateFromError(): BoundaryState {');
    expect(provider).toContain('<ErrorBoundary>{children}</ErrorBoundary>');
    // the generated text has to lint clean before anything formats it
    const options = {
      ...(JSON.parse(await fs.readFile(path.join(FIXTURE, '.prettierrc'), 'utf8')) as object),
      parser: 'typescript' as const,
    };
    expect(await format(provider, options)).toBe(provider);
  });

  it('refuses a snapshot missing a dependency it keeps, and writes zones per feature', () => {
    expect(() => packageJson({ dependencies: { next: '1' }, devDependencies: {} }, 'x')).toThrow(
      /has no react/,
    );
    const text = eslintConfig(['index', 'about']);
    expect(text).toContain("target: './src/features/index'");
    expect(text).toContain("except: ['./index']");
    expect(text).toContain("except: ['./about']");
    expect(tailwindConfig(EMPTY_TOKENS)).toContain("require('tailwindcss-animate')");
  });
});

describe('the dev server helpers', () => {
  it('finds a free port, sees a closed one as down and a static server as up', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(0);
    expect(await isUp(`http://127.0.0.1:${port}/`)).toBe(false);
    await expect(
      waitForServer(`http://127.0.0.1:${port}/`, { timeoutMs: 300, pollMs: 50 }),
    ).rejects.toThrow(/did not answer within 300 ms/);
    const server = await serveStatic(path.resolve('test/fixtures/site'));
    try {
      expect(await isUp(`${server.url}/`)).toBe(true);
      // a 404 is not up, per playwright's rule
      expect(await isUp(`${server.url}/nope.html`)).toBe(false);
      await expect(
        waitForServer(`${server.url}/`, { timeoutMs: 1000, pollMs: 50 }),
      ).resolves.toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it('refuses a port another server holds, before it spawns anything', async () => {
    const project = await devProject('port-taken', 'node hang.cjs dev.pid');
    const log = path.join(root, 'port-taken.log');
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', r));
    const port = (taken.address() as net.AddressInfo).port;
    try {
      const err = await startDevServer({ project, log, port }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PortInUseError);
      expect((err as PortInUseError).port).toBe(port);
      expect((err as Error).message).toContain(project);
      // the log is the first thing the spawn writes, so its absence is the proof no child ran
      await expect(fs.stat(log)).rejects.toThrow(/ENOENT/);
    } finally {
      await new Promise<void>((r) => taken.close(() => r()));
    }
  });

  it('refuses a url a dev server that moved would answer on', async () => {
    // something does answer here, but the log says next went looking for another port, so what
    // answered is not the server we started and the url must not be handed back
    const project = await devProject('moved', 'node moved.cjs');
    const log = path.join(root, 'moved.log');
    const err = await startDevServer({ project, log, timeoutMs: 10_000, pollMs: 100 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PortInUseError);
    expect((err as Error).message).toContain('moved to another port');
    expect(await isUp(`http://127.0.0.1:${(err as PortInUseError).port}/`)).toBe(false);
  });

  it('writes the pid beside the log while it is up and takes it away on stop', async () => {
    const project = await devProject('pidfile', 'node moved-ok.cjs');
    await fs.writeFile(
      path.join(project, 'moved-ok.cjs'),
      "const http = require('node:http');\n" +
        "const port = Number(process.argv[process.argv.indexOf('-p') + 1]);\n" +
        "http.createServer((_req, res) => res.writeHead(200).end('ok')).listen(port, '127.0.0.1');\n",
    );
    const log = path.join(root, 'pidfile-run', 'dev-server.log');
    const pidFile = path.join(path.dirname(log), 'dev-server.pid');
    // the no-op negative: nothing is there before a server is started
    await expect(fs.stat(pidFile)).rejects.toThrow(/ENOENT/);
    const dev = await startDevServer({ project, log, timeoutMs: 20_000, pollMs: 100 });
    // the server is detached so its group can be signalled, which also means a hard kill of
    // the orchestrator leaves it holding the port: the file is how the next build finds it
    const pid = Number(await fs.readFile(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(processAlive(pid)).toBe(true);
    await dev.stop();
    await waitGone(pid);
    await expect(fs.stat(pidFile)).rejects.toThrow(/ENOENT/);
  });

  it('kills the dev server a dead run left holding its port, and takes the pid file with it', async () => {
    const pack = path.join(root, 'stale-pack');
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const pidFile = (run: string) => path.join(pack, 'runs', run, 'dev-server.pid');

    // the no-op negative: a run dir with no pid file started no server of its own, so there is
    // nothing to signal and nothing to say
    await fs.mkdir(path.dirname(pidFile('r0')), { recursive: true });
    await killStaleDevServers(pack, 'r1', log);
    expect(lines).toEqual([]);

    // a detached child is its own group leader, which is what the dev server is and why its
    // group can be signalled after the run that started it was killed
    const child = execa('sleep', ['60'], { detached: true, cleanup: false, reject: false });
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);
    await fs.mkdir(path.dirname(pidFile('r0')), { recursive: true });
    await fs.writeFile(pidFile('r0'), `${pid}\n`);
    // this run's own pid file is never touched: the server it names is the one just started
    await fs.mkdir(path.dirname(pidFile('r1')), { recursive: true });
    await fs.writeFile(pidFile('r1'), `${process.pid}\n`);

    const started = Date.now();
    await killStaleDevServers(pack, 'r1', log);
    const ended = await child;
    // our signal is what ended it, and it went at once rather than living out its 60 seconds
    expect(ended.signal).toBe('SIGTERM');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(processAlive(pid)).toBe(false);
    expect(lines[0]).toContain(`run r0 left a dev server running (pid ${pid})`);
    expect(lines[1]).toContain('stopped on SIGTERM');
    await expect(fs.stat(pidFile('r0'))).rejects.toThrow(/ENOENT/);
    await expect(fs.stat(pidFile('r1'))).resolves.toBeTruthy();
  });

  it('kills a dev server that never answers, and names the log when one cannot start', async () => {
    const hang = await devProject('hang', 'node hang.cjs dev.pid');
    const hangLog = path.join(root, 'hang.log');
    await expect(
      startDevServer({ project: hang, log: hangLog, timeoutMs: 2_000, pollMs: 100 }),
    ).rejects.toThrow(/did not answer within 2000 ms/);
    const pid = Number(await fs.readFile(path.join(hang, 'dev.pid'), 'utf8'));
    expect(pid).toBeGreaterThan(0);
    // stop() signalled the whole group, so the script npm started is gone with npm
    await waitGone(pid);
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);

    // a project with no node_modules: npm runs the script, the binary is not there
    const bare = await devProject('bare', 'next dev');
    const bareLog = path.join(root, 'bare.log');
    const bareErr = (await startDevServer({ project: bare, log: bareLog }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(bareErr.message).toMatch(/npm run dev exited with/);
    expect(bareErr.message).toContain(bareLog);

    // nothing to spawn at all: execa resolves with no code and no signal, only its own message
    const goneErr = (await startDevServer({
      project: bare,
      log: bareLog,
      env: { PATH: path.join(root, 'no-bin') },
    }).catch((e: unknown) => e)) as Error;
    expect(goneErr.message).toMatch(/ENOENT|Command failed/);
  });
});

describe('scaffoldProject over a failed install', () => {
  it('takes the dir it made with it, and leaves a dir it found alone', async () => {
    const boom = () => Promise.reject(new Error('npm install blew up'));
    const out = path.join(root, 'failed-install');
    await expect(
      scaffoldProject({ out, name: 'x-rebuild', source: FIXTURE, installer: boom }),
    ).rejects.toThrow(/npm install blew up; .*was cleaned up, so the scaffold can be run again/);
    await expect(fs.stat(out)).rejects.toThrow(/ENOENT/);
    // the retry an operator reaches for first is not refused by the package.json guard
    const again = await scaffoldProject({
      out,
      name: 'x-rebuild',
      source: FIXTURE,
      install: false,
    });
    expect(again.project).toBe(out);

    const kept = path.join(root, 'kept');
    await fs.mkdir(kept, { recursive: true });
    await fs.writeFile(path.join(kept, 'notes.md'), 'mine\n');
    await expect(
      scaffoldProject({ out: kept, name: 'x-rebuild', source: FIXTURE, installer: boom }),
    ).rejects.toThrow(/npm install blew up/);
    expect(await listFiles(kept)).toEqual(['notes.md']);
  });
});

describe('a tarball that is not the pinned tree', () => {
  it('names the member it wanted, and never asks the network for it', async () => {
    const cacheDir = path.join(root, 'bad-cache');
    const stage = path.join(root, 'bad-stage');
    const inner = path.join(stage, 'some-other-dir', 'apps', 'nextjs-app');
    await fs.mkdir(inner, { recursive: true });
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(inner, 'package.json'), '{}\n');
    await execa('tar', [
      '-czf',
      path.join(cacheDir, `bulletproof-react-${SNAPSHOT.commit}.tar.gz`),
      '-C',
      stage,
      'some-other-dir',
    ]);
    const err = await fetchSnapshot({
      cacheDir,
      fetch: () => Promise.reject(new Error('no network for you')),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SnapshotError);
    expect((err as Error).message).toContain(
      `bulletproof-react-${SNAPSHOT.commit}/apps/nextjs-app/package.json`,
    );
  });
});

describe('generation helpers', () => {
  const section = (id: string, order: number, role: string, heading: string): Section => ({
    id,
    order,
    role,
    heading,
    selector: 'x',
    path: `body>x:nth-of-type(${order})`,
    ref: `r${order}`,
    dataSection: null,
    bbox: { mobile: null, desktop: null },
    items: [],
    buttons: [],
    imageCount: 0,
    svgCount: 0,
  });

  it('turns a computed colour into a theme token and leaves anything else alone', () => {
    // computed styles never say hex or a keyword: nothing to token
    expect(colourToken('#2563eb')).toBeNull();
    expect(colourToken('linear-gradient(red, blue)')).toBeNull();
    expect(colourToken('rgba(0, 0, 0, 0)')).toBeNull();
    expect(colourToken('rgb(37, 99, 235)')).toEqual({ name: 'pack-2563eb', value: '#2563eb' });
    expect(colourToken('rgba(0, 0, 0, 0.5)')).toEqual({
      name: 'pack-000000-50',
      value: 'rgba(0, 0, 0, 0.5)',
    });
  });

  it('writes a section stub with the landmark tag, the id and an escaped heading', () => {
    const hero = sectionStub(
      section('s02-hero-know-before-you-go', 2, 'hero', "Know before you go, it's <fast>"),
    );
    expect(hero).toContain('export const S02HeroKnowBeforeYouGo = () => {');
    expect(hero).toContain(
      '<section data-section="s02-hero-know-before-you-go" className="min-h-20">',
    );
    expect(hero).toContain('<h1>Know before you go, it&apos;s &lt;fast&gt;</h1>');
    const footer = sectionStub(section('s06-footer', 6, 'footer', ''));
    expect(footer).toContain('<footer data-section="s06-footer" className="min-h-20">');
    expect(footer).toContain('{/* footer */}');
    expect(footer).not.toContain('<h2>');
    expect(chromeStub('header')).toContain(
      'export const SiteHeader = ({ sectionId }: SiteHeaderProps) => {',
    );
    expect(chromeStub('header')).toContain(
      '<header data-section={sectionId} className="min-h-20">',
    );
    // a shared chrome section keeps the file the mapping names; the markup is the layout's
    const wrapper = chromeSectionStub(section('s01-header', 1, 'header', ''));
    expect(wrapper).toContain("import { SiteHeader } from '@/components/layouts/site-header';");
    expect(wrapper).toContain('export const S01Header = () => {');
    expect(wrapper).toContain('return <SiteHeader sectionId="s01-header" />;');
    const step = stepStub('signup', 'step-01-click-talk-to-us', 1);
    expect(step).toContain('export const Step01ClickTalkToUs = () => {');
    // a step is one interaction on a page, not a section of its own
    expect(step).not.toContain('data-section');
  });

  it('writes the stubs the way the project would format them, at any id or heading length', () => {
    // the generated text has to lint clean before anything formats it, and the project's
    // prettier prints at 80 columns
    const long = sectionStub(
      section(
        's03-features-everything-you-need-and-a-great-deal-more-besides',
        3,
        'features',
        'Everything you need and then a good many more words to push this heading well past eighty columns',
      ),
    );
    expect(long).toContain(
      '    <section\n      data-section="s03-features-everything-you-need-and-a-great-deal-more-besides"\n      className="min-h-20"\n    >',
    );
    expect(long).toContain(
      '      <h2>\n' +
        '        Everything you need and then a good many more words to push this heading\n' +
        '        well past eighty columns\n' +
        '      </h2>',
    );
    // one attribute and one comment child: prettier keeps a short step stub on one line, then
    // parenthesises the same line, then breaks it
    expect(stepStub('a', 'step-01-x', 1)).toContain(
      '  return <section className="min-h-20">{/* flow a, step 1 */}</section>;',
    );
    expect(stepStub('book-a-demo', 'step-01-x', 1)).toContain(
      '  return (\n' +
        '    <section className="min-h-20">{/* flow book-a-demo, step 1 */}</section>\n' +
        '  );',
    );
    expect(stepStub('signup-with-a-much-longer-name', 'step-01-click-talk-to-us', 1)).toContain(
      '    <section className="min-h-20">\n' +
        '      {/* flow signup-with-a-much-longer-name, step 1 */}\n' +
        '    </section>',
    );
    // prettier never breaks a lone string attribute, so a long wrapper only gains parentheses
    const wide = chromeSectionStub(
      section('s06-footer-get-in-touch-with-us-today-please-now-ok', 6, 'footer', ''),
    );
    expect(wide).toContain(
      '  return (\n    <SiteFooter sectionId="s06-footer-get-in-touch-with-us-today-please-now-ok" />\n  );',
    );
  });

  it('writes what the project’s own prettier writes, at every length that changes the shape', async () => {
    // the gate on the emitters: the generated text has to lint clean before anything formats
    // it, so run the real prettier with the snapshot's own .prettierrc over a sweep of the
    // lengths that move a line past the print width
    const options = {
      ...(JSON.parse(await fs.readFile(path.join(FIXTURE, '.prettierrc'), 'utf8')) as object),
      parser: 'typescript' as const,
    };
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
    const wide = (prefix: string, length: number) => (prefix + 'x'.repeat(length)).slice(0, length);
    const cases: { what: string; text: string }[] = [];
    // the step id varies too, up to the four words stepSlug can put in one: at the longest,
    // `export const <name> = () => {` is itself past the print width and prettier breaks the
    // declaration, which is the emitter's last rung and was never reached with a fixed id
    const stepIds = [
      'step-01-open',
      'step-01-click-talk',
      'step-01-click-talk-to',
      'step-01-click-talk-to-us',
      'step-10-input-work-email-address-please',
    ];
    for (let n = 1; n <= 24; n++) {
      const flow = 'book-a-demo-and-contact-us'.slice(0, n);
      for (const step of [1, 10]) {
        for (const id of stepIds) {
          cases.push({
            what: `stepStub ${flow} ${id} ${step}`,
            text: stepStub(flow, id, step),
          });
        }
      }
    }
    for (const length of [8, 60]) {
      for (const heading of [words(0), words(1), words(8), words(40), 'y'.repeat(120)]) {
        for (const role of ['hero', 'features']) {
          cases.push({
            what: `sectionStub ${role} id ${length} heading ${heading.length}`,
            text: sectionStub(section(wide('s02-sec-', length), 2, role, heading)),
          });
        }
      }
      cases.push({
        what: `chromeSectionStub id ${length}`,
        text: chromeSectionStub(section(wide('s01-hea-', length), 1, 'header', '')),
      });
      cases.push({
        what: `routeFile one section id ${length}`,
        text: routeFile({
          feature: 'index',
          sections: [section(wide('s02-hero-', length), 2, 'hero', 'Hi')],
        }),
      });
    }
    cases.push({
      what: 'routeFile no sections',
      text: routeFile({ feature: 'index', sections: [] }),
    });
    cases.push({
      what: 'routeFile three sections',
      text: routeFile({
        feature: 'index',
        sections: [
          section('s01-header', 1, 'header', ''),
          section('s02-hero-hi', 2, 'hero', 'Hi'),
          section('s03-footer', 3, 'footer', ''),
        ],
      }),
    });
    for (const c of cases) expect(await format(c.text, options), c.what).toBe(c.text);
    expect(cases.length).toBeGreaterThan(60);
  });

  it('composes a route: chrome outside main, the sections inside, imports sorted by path', () => {
    const text = routeFile({
      feature: 'index',
      sections: [
        section('s01-header', 1, 'header', ''),
        section('s02-hero-hi', 2, 'hero', 'Hi'),
        section('s03-cta-go', 3, 'cta', 'Go'),
        section('s04-footer', 4, 'footer', ''),
      ],
    });
    expect(text.split('\n').slice(0, 4)).toEqual([
      "import { S01Header } from '@/features/index/components/s01-header';",
      "import { S02HeroHi } from '@/features/index/components/s02-hero-hi';",
      "import { S03CtaGo } from '@/features/index/components/s03-cta-go';",
      "import { S04Footer } from '@/features/index/components/s04-footer';",
    ]);
    expect(text).toContain('<S01Header />');
    expect(text.indexOf('<S01Header />')).toBeLessThan(text.indexOf('<main>'));
    expect(text.indexOf('<S02HeroHi />')).toBeLessThan(text.indexOf('<S03CtaGo />'));
    expect(text.indexOf('</main>')).toBeLessThan(text.indexOf('<S04Footer />'));
    expect(text).toContain('export default Page;');
  });

  it('imports a repeated component once, and renders an empty page as a bare main', () => {
    const twoNavs = routeFile({
      feature: 'index',
      sections: [
        section('s01-nav', 1, 'nav', ''),
        section('s02-hero-hi', 2, 'hero', 'Hi'),
        section('s03-nav', 3, 'nav', ''),
      ],
    });
    expect(twoNavs.match(/^import /gm)).toHaveLength(3);
    const same = routeFile({
      feature: 'index',
      sections: [section('s01-nav', 1, 'nav', ''), section('s01-nav', 1, 'nav', '')],
    });
    expect(same.match(/^import /gm)).toHaveLength(1);
    expect(same.match(/<S01Nav \/>/g)).toHaveLength(2);
    // chrome only, so there is no order to split on: the nav is above, the footer below
    const chromeOnly = routeFile({
      feature: 'index',
      sections: [section('s01-nav', 1, 'nav', ''), section('s02-footer', 2, 'footer', '')],
    });
    expect(chromeOnly.indexOf('<S01Nav />')).toBeLessThan(chromeOnly.indexOf('<main />'));
    expect(chromeOnly.indexOf('<main />')).toBeLessThan(chromeOnly.indexOf('<S02Footer />'));
    // nothing to import: the file starts at the component, with no blank line above it
    const empty = routeFile({ feature: 'index', sections: [] });
    expect(empty.startsWith('const Page = () => {')).toBe(true);
    expect(empty).toContain('<main />');
  });

  it('collects theme tokens and font faces from the pack', () => {
    const meta = {
      colours: ['rgb(37, 99, 235)', 'rgba(0, 0, 0, 0)', 'rgb(37, 99, 235)', 'rgb(17, 24, 39)'],
      fonts: [
        {
          family: 'Fixture',
          weight: '400',
          style: 'normal',
          status: 'loaded',
          file: 'font-a-Fixture-Regular.woff2',
          url: 'u',
        },
        {
          family: 'Fixture',
          weight: '700',
          style: 'normal',
          status: 'loaded',
          file: 'font-b-a1b2.woff2',
          url: 'u2',
        },
        {
          family: 'Arial',
          weight: '400',
          style: 'normal',
          status: 'loaded',
          file: null,
          url: null,
        },
      ],
    } as unknown as PageMeta;
    const animations = {
      keyframes: {
        pulse: {
          from: 'cssom',
          stops: [
            { offset: '0%', declarations: { transform: 'scale(1)' } },
            { offset: '50%', declarations: { transform: 'scale(1.08)' } },
          ],
        },
      },
      elements: {
        mobile: {},
        desktop: {
          'body>span:nth-of-type(1)': {
            ref: 'r1',
            dataRef: null,
            animation: {
              'animation-name': 'pulse',
              'animation-duration': '2s',
              'animation-timing-function': 'ease-in-out',
              'animation-delay': '0s',
              'animation-iteration-count': 'infinite',
              'animation-direction': 'normal',
              'animation-fill-mode': 'none',
              'animation-play-state': 'running',
            },
            transition: null,
          },
        },
      },
      observed: { mobile: [], desktop: [] },
      unreadableStylesheets: [],
    } as AnimationsFile;
    expect(tokensFrom([meta], [animations])).toEqual({
      colors: { 'pack-111827': '#111827', 'pack-2563eb': '#2563eb' },
      fontFamily: { arial: ['Arial'], fixture: ['Fixture'] },
      keyframes: {
        pulse: { '0%': { transform: 'scale(1)' }, '50%': { transform: 'scale(1.08)' } },
      },
      animation: { pulse: 'pulse 2s ease-in-out 0s infinite normal none' },
    });
    // a timing function has commas of its own: the shorthand keeps it whole
    const eased = structuredClone(animations);
    eased.elements.desktop['body>span:nth-of-type(1)']!.animation!['animation-timing-function'] =
      'cubic-bezier(0.4, 0, 0.2, 1)';
    expect(tokensFrom([], [eased]).animation).toEqual({
      pulse: 'pulse 2s cubic-bezier(0.4, 0, 0.2, 1) 0s infinite normal none',
    });
    const css = fontsCss([
      { family: 'Fixture', weight: '400', style: 'normal', file: 'font-a-Fixture-Regular.woff2' },
      { family: 'Fixture', weight: '700', style: 'normal', file: 'font-b-a1b2.ttf' },
    ]);
    expect(css).toContain("font-family: 'Fixture';");
    expect(css).toContain(
      "src: url('../assets/fonts/font-a-Fixture-Regular.woff2') format('woff2');",
    );
    expect(css).toContain("src: url('../assets/fonts/font-b-a1b2.ttf') format('truetype');");
    expect(css).toContain('font-weight: 700;');
  });
});

describe('generateFromPack over a pack', () => {
  /** synthPack indexes two assets but writes no bytes; the generator copies real files */
  async function writeAssets(pack: string, slug: string): Promise<void> {
    const paths = new PackPaths(pack);
    const dir = paths.assetsDir(paths.pageDir(slug));
    for (const name of ['font-abc-Fixture-Regular.woff2', 'image-def-hero.png']) {
      await fs.writeFile(path.join(dir, name), name);
    }
  }

  it('gives a flow a feature of its own, a stub per step and the page its route', async () => {
    const pack = path.join(root, 'synth-pack');
    await synthPack(pack);
    await writeAssets(pack, 'index');
    const out = path.join(root, 'synth-project');
    const r = await scaffoldProject({
      out,
      name: 'synth-rebuild',
      source: FIXTURE,
      root: pack,
      install: false,
    });
    const g = r.generated!;
    expect(g.features).toEqual(['index', 'signup']);
    expect(g.components).toContain('src/features/signup/components/step-01-click-open.tsx');
    const step = await fs.readFile(
      path.join(out, 'src/features/signup/components/step-01-click-open.tsx'),
      'utf8',
    );
    expect(step).toContain('export const Step01ClickOpen = () => {');
    expect(step).toContain('{/* flow signup, step 1 */}');
    // a step is an interaction on a page, never a section of its own
    expect(step).not.toContain('data-section');
    // one page, so its header is the page's own and there is no layout to share
    expect(g.layouts).toEqual([]);
    expect(g.routes).toEqual(['src/app/page.tsx']);
    const route = await fs.readFile(path.join(out, 'src/app/page.tsx'), 'utf8');
    expect(route).toContain("import { S01Header } from '@/features/index/components/s01-header';");
    expect(route).toContain('<S02HeroHello />');
    const header = await fs.readFile(
      path.join(out, 'src/features/index/components/s01-header.tsx'),
      'utf8',
    );
    expect(header).toContain('<header data-section="s01-header" className="min-h-20">');
  });

  it('gives a nested url and a digit-leading one a feature dir of their own', async () => {
    const pack = path.join(root, 'nested-pack');
    const m = await synthPack(pack);
    await writeAssets(pack, 'index');
    const paths = new PackPaths(pack);
    const base = {
      status: 'captured' as const,
      dependsOn: [],
      rounds: 0,
      updatedAt: '2026-09-18T00:00:00.000Z',
    };
    // slugFromUrl joins path segments with a double hyphen and keeps a leading digit; the
    // feature dir is that slug, and check-file's KEBAB_CASE admits neither
    for (const [slug, url] of [
      ['blog--hello', `${SYNTH_URL}blog/hello`],
      ['2024--report', `${SYNTH_URL}2024/report`],
    ]) {
      await fs.cp(paths.pageDir('index'), paths.pageDir(slug!), { recursive: true });
      m.units[`page:${slug}`] = { kind: 'page', url, ...base };
      m.units[`page:${slug}#s01-header`] = { kind: 'section', ...base };
      m.units[`page:${slug}#s02-hero-hello`] = { kind: 'section', ...base };
    }
    await saveManifest(pack, m);
    const project = path.join(root, 'nested-project');
    const g = await generateFromPack({ root: pack, project });
    expect(g.features).toEqual(['2024--report', 'blog--hello', 'index', 'signup']);
    expect(g.routes).toEqual([
      'src/app/2024/report/page.tsx',
      'src/app/blog/hello/page.tsx',
      'src/app/page.tsx',
    ]);
    for (const slug of ['blog--hello', '2024--report']) {
      const rel = `src/features/${slug}/components/s02-hero-hello.tsx`;
      expect(g.components, slug).toContain(rel);
      await expect(fs.stat(path.join(project, rel)), slug).resolves.toBeTruthy();
    }
    // the generated config has to admit the dirs the generator just wrote, or every round for
    // those pages fails its own `next lint` check and the page blocks at the budget
    const eslint = await fs.readFile(path.join(project, '.eslintrc.cjs'), 'utf8');
    expect(eslint).toContain("target: './src/features/2024--report'");
    expect(eslint).toContain("'!(src/app)/**/*': '+([a-z0-9])*(-*([a-z0-9]))'");
  });

  it('shares chrome that is on more than one page as a layout, and still stubs every section', async () => {
    const pack = path.join(root, 'two-page-pack');
    const m = await synthPack(pack);
    await writeAssets(pack, 'index');
    const paths = new PackPaths(pack);
    await fs.cp(paths.pageDir('index'), paths.pageDir('about'), { recursive: true });
    const base = {
      status: 'captured' as const,
      dependsOn: [],
      rounds: 0,
      updatedAt: '2026-09-18T00:00:00.000Z',
    };
    m.units['page:about'] = { kind: 'page', url: `${SYNTH_URL}about`, ...base };
    m.units['page:about#s01-header'] = { kind: 'section', ...base };
    m.units['page:about#s02-hero-hello'] = { kind: 'section', ...base };
    await saveManifest(pack, m);
    const project = path.join(root, 'two-page-project');
    const g = await generateFromPack({ root: pack, project });
    expect(g.layouts).toEqual(['src/components/layouts/site-header.tsx']);
    expect(g.features).toEqual(['about', 'index', 'signup']);
    const layout = await fs.readFile(
      path.join(project, 'src/components/layouts/site-header.tsx'),
      'utf8',
    );
    expect(layout).toContain('<header data-section={sectionId} className="min-h-20">');
    for (const feature of ['about', 'index']) {
      // the section unit still has the file the mapping names, so a worker for it has one
      const rel = `src/features/${feature}/components/s01-header.tsx`;
      expect(g.components, feature).toContain(rel);
      const stub = await fs.readFile(path.join(project, rel), 'utf8');
      expect(stub, feature).toContain(
        "import { SiteHeader } from '@/components/layouts/site-header';",
      );
      expect(stub, feature).toContain('return <SiteHeader sectionId="s01-header" />;');
      const route = await fs.readFile(
        path.join(project, feature === 'index' ? 'src/app/page.tsx' : 'src/app/about/page.tsx'),
        'utf8',
      );
      expect(route, feature).toContain(
        `import { S01Header } from '@/features/${feature}/components/s01-header';`,
      );
      expect(route, feature).not.toContain('@/components/layouts');
    }
  });
});
