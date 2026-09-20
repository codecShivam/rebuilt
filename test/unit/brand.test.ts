import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  applyBrandTokens,
  applyNames,
  brandFontFaces,
  brandProject,
  deviationsText,
  diffTrees,
  familyLeftovers,
  loadBrand,
  replaceLogos,
  resolveAsset,
  snapshotTree,
  substituteInSource,
  writeTheme,
} from '../../src/orchestrate/brand';
import {
  NO_FONTS_CSS,
  fontsCssFor,
  generateFromPack,
  packTheme,
} from '../../src/orchestrate/scaffold/generate';
import { EMPTY_TOKENS, type ThemeTokens } from '../../src/orchestrate/scaffold/template';
import { writeJson } from '../../src/pack/io';
import { PackPaths } from '../../src/pack/paths';
import type { Brand } from '../../src/pack/schemas';
import { synthPack } from '../helpers/pack';

const require = createRequire(import.meta.url);
let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-brand-unit-'));
  // the generated tailwind config requires its one plugin by name; the unit run installs
  // nothing, so the plugin is stubbed above every project here, where node's resolution walks
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

const TOKENS: ThemeTokens = {
  colors: { 'pack-111827': '#111827', 'pack-2563eb': '#2563eb' },
  fontFamily: { arial: ['Arial'], fixture: ['Fixture'] },
  keyframes: {},
  animation: {},
};
const EMPTY: Brand = { names: {}, logos: {}, colors: {}, fonts: {} };
const FONTS = [
  { family: 'Fixture', weight: '400', style: 'normal', file: 'font-a-Fixture-Regular.woff2' },
  { family: 'Fixture', weight: '700', style: 'normal', file: 'font-b-a1b2.woff2' },
  { family: 'Other', weight: '400', style: 'normal', file: 'font-c-Other.woff2' },
];

/** a brand dir with one face file and one logo, and its brand.json */
async function brandDir(name: string, brand: Brand): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'fonts'), { recursive: true });
  await fs.writeFile(path.join(dir, 'fonts', 'Acme-Regular.woff2'), 'acme 400');
  await fs.writeFile(path.join(dir, 'logo.png'), 'acme logo');
  await fs.writeFile(path.join(dir, 'logo.svg'), '<svg />');
  await writeJson(path.join(dir, 'brand.json'), brand);
  return path.join(dir, 'brand.json');
}

const ACME: Brand = {
  names: { 'Fixture Co': 'Acme Ltd', Fixture: 'Acme' },
  logos: { 'hero.png': 'logo.png' },
  colors: { 'pack-2563eb': '#e11d48' },
  fonts: {
    Fixture: {
      family: 'Acme Sans',
      faces: [{ file: 'fonts/Acme-Regular.woff2', weight: '400', style: 'normal' }],
    },
  },
};

describe('loadBrand', () => {
  it('resolves the files it names against its own dir and refuses one that is not there', async () => {
    const file = await brandDir('ok', ACME);
    const loaded = await loadBrand(file);
    expect(loaded.dir).toBe(path.dirname(file));
    expect(loaded.brand).toEqual(ACME);
    const missing = await brandDir('missing', {
      ...ACME,
      logos: { 'hero.png': 'nope.png' },
    });
    await expect(loadBrand(missing)).rejects.toThrow(/logos\.hero\.png names nope\.png/);
  });

  it('refuses a file that is there but outside its own dir, as the message says it does', async () => {
    await fs.writeFile(path.join(root, 'outside.png'), 'outside');
    const up = await brandDir('outside', { ...ACME, logos: { 'hero.png': '../outside.png' } });
    await expect(loadBrand(up)).rejects.toThrow(
      /logos\.hero\.png names \.\.\/outside\.png, which is not under/,
    );
    const absolute = await brandDir('outside-absolute', {
      ...ACME,
      fonts: {
        Fixture: {
          family: 'Acme Sans',
          faces: [{ file: path.join(root, 'outside.png'), weight: '400', style: 'normal' }],
        },
      },
    });
    await expect(loadBrand(absolute)).rejects.toThrow(
      /fonts\.Fixture\.faces\.0\.file names .*outside\.png, which is not under/,
    );
  });
});

describe('applyBrandTokens', () => {
  it('returns the tokens as they were for an empty brand', () => {
    // the no-op negative
    expect(applyBrandTokens(TOKENS, EMPTY)).toEqual(TOKENS);
    expect(applyBrandTokens(EMPTY_TOKENS, EMPTY)).toEqual(EMPTY_TOKENS);
  });

  it('overrides a colour value under its own name and a family under its own key', () => {
    const t = applyBrandTokens(TOKENS, ACME);
    expect(t.colors).toEqual({ 'pack-111827': '#111827', 'pack-2563eb': '#e11d48' });
    expect(t.fontFamily).toEqual({ arial: ['Arial'], fixture: ['Acme Sans'] });
    // the input is not written to
    expect(TOKENS.colors['pack-2563eb']).toBe('#2563eb');
  });

  it('refuses a token or a family the theme does not have, naming what it has', () => {
    expect(() => applyBrandTokens(TOKENS, { ...EMPTY, colors: { 'pack-ffffff': '#000' } })).toThrow(
      /no token pack-ffffff; it has pack-111827, pack-2563eb/,
    );
    expect(() =>
      applyBrandTokens(TOKENS, { ...EMPTY, fonts: { Inter: ACME.fonts['Fixture']! } }),
    ).toThrow(/no family Inter; it has Arial; Fixture/);
  });
});

describe('brandFontFaces', () => {
  it('hands the faces back as they were for an empty brand', () => {
    // the no-op negative
    expect(brandFontFaces(FONTS, EMPTY, '/b')).toEqual({ faces: FONTS, removed: [], copies: [] });
  });

  it('drops the source family and adds the brand faces by basename, in the pack order', () => {
    const r = brandFontFaces(FONTS, ACME, '/b');
    // the faces the brand leaves alone stand where the pack had them, the brand's follow
    expect(r.faces).toEqual([
      { family: 'Other', weight: '400', style: 'normal', file: 'font-c-Other.woff2' },
      { family: 'Acme Sans', weight: '400', style: 'normal', file: 'Acme-Regular.woff2' },
    ]);
    expect(r.removed).toEqual(['font-a-Fixture-Regular.woff2', 'font-b-a1b2.woff2']);
    expect(r.copies).toEqual([{ from: '/b/fonts/Acme-Regular.woff2', file: 'Acme-Regular.woff2' }]);
    expect(fontsCssFor(r.faces)).toContain("font-family: 'Acme Sans';");
    expect(fontsCssFor(r.faces)).toContain(
      "src: url('../assets/fonts/Acme-Regular.woff2') format('woff2');",
    );
    expect(fontsCssFor([])).toBe(NO_FONTS_CSS);
  });

  it('keeps a brand face whose basename is a source face of the family it overrides', () => {
    const over: Brand = {
      ...EMPTY,
      fonts: {
        Fixture: {
          family: 'Acme Sans',
          faces: [{ file: 'fonts/font-a-Fixture-Regular.woff2', weight: '400', style: 'normal' }],
        },
      },
    };
    const r = brandFontFaces(FONTS, over, '/b');
    expect(r.copies).toEqual([
      { from: '/b/fonts/font-a-Fixture-Regular.woff2', file: 'font-a-Fixture-Regular.woff2' },
    ]);
    // the copy lands on that name, so removing it afterwards would delete the face the css names
    expect(r.removed).toEqual(['font-b-a1b2.woff2']);
    expect(r.faces).toEqual([
      { family: 'Other', weight: '400', style: 'normal', file: 'font-c-Other.woff2' },
      { family: 'Acme Sans', weight: '400', style: 'normal', file: 'font-a-Fixture-Regular.woff2' },
    ]);
  });
});

describe('substituteInSource', () => {
  const SOURCE = [
    "import { SiteHeader } from '@/components/layouts/site-fixture';",
    "import hero from '@/assets/image-abc-fixture-co.png';",
    '',
    'export const S02HeroFixture = () => {',
    '  return (',
    '    <section data-section="s02-hero-fixture" className="min-h-20 font-fixture">',
    '      <h1>Fixture Co</h1>',
    '      <p id="fixture-note">fixture co and FIXTURE CO</p>',
    '      <img src={hero.src} alt="Fixture Co logo" />',
    '      <a href="/fixture">Fixture</a>',
    '    </section>',
    '  );',
    '};',
    '',
  ].join('\n');

  const WITH_SCANNER = { ...ACME.names, Scanner: 'Acme Scan' };

  it('leaves the file alone with no names', () => {
    // the no-op negative
    expect(substituteInSource(SOURCE, {})).toEqual({ text: SOURCE, counts: {} });
  });

  it('replaces the words and never a specifier, a data attribute, a class, an id or a path', () => {
    const r = substituteInSource(SOURCE, ACME.names);
    expect(r.text).toContain("import { SiteHeader } from '@/components/layouts/site-fixture';");
    expect(r.text).toContain("import hero from '@/assets/image-abc-fixture-co.png';");
    expect(r.text).toContain('data-section="s02-hero-fixture" className="min-h-20 font-fixture"');
    expect(r.text).toContain('<h1>Acme Ltd</h1>');
    expect(r.text).toContain('<p id="fixture-note">acme ltd and ACME LTD</p>');
    expect(r.text).toContain('alt="Acme Ltd logo"');
    expect(r.text).toContain('<a href="/fixture">Acme</a>');
    // the component name is one word, and the words inside it are not
    expect(r.text).toContain('export const S02HeroFixture = () => {');
    expect(r.counts).toEqual({ 'Fixture Co': 4, Fixture: 1 });
  });

  it('substitutes a string literal that is not path-shaped', () => {
    // the no-op negative for the path rule: a literal is fenced for beginning the way a path
    // begins, never for being quoted
    const r = substituteInSource("const labels = ['Scanner', 'Fixture Co'];", WITH_SCANNER);
    expect(r.text).toBe("const labels = ['Acme Scan', 'Acme Ltd'];");
    expect(r.counts).toEqual({ Scanner: 1, 'Fixture Co': 1 });
  });

  it('fences a path-shaped literal wherever it stands, not only in an attribute', () => {
    const links = "const links = [{ href: '/scanner', label: 'Scanner' }];";
    expect(substituteInSource(links, WITH_SCANNER).text).toBe(
      "const links = [{ href: '/scanner', label: 'Acme Scan' }];",
    );
    for (const line of [
      "const href = '/fixture/about';",
      "export const paths = { home: { getHref: () => '/' } } as const;",
      "const up = '../fixture/about';",
      "const here = './fixture';",
      "const anchor = '#fixture-top';",
      "const site = 'https://fixture.example/fixture';",
      'const tpl = `/fixture/about`;',
    ])
      expect(substituteInSource(line, WITH_SCANNER).text, line).toBe(line);
  });

  it('fences the sectionId the wrapper stubs carry, in both forms', () => {
    const wrapper = '<SiteHeader sectionId="s01-header-fixture-co" />';
    expect(substituteInSource(`${wrapper}\n<h1>Fixture Co</h1>\n`, ACME.names).text).toBe(
      `${wrapper}\n<h1>Acme Ltd</h1>\n`,
    );
    const expression = "<SiteHeader sectionId={'s01-header-fixture-co'} />";
    expect(substituteInSource(expression, ACME.names).text).toBe(expression);
  });

  it('fences every data- attribute, not three of them by name', () => {
    expect(
      substituteInSource('<div data-testid="fixture-card">Fixture Co</div>', ACME.names).text,
    ).toBe('<div data-testid="fixture-card">Acme Ltd</div>');
  });

  it('fences a value prettier broke over lines', () => {
    const cls = [
      '<div',
      '  className={cn(',
      "    'fixture-card',",
      "    active && 'fixture-active',",
      '  )}',
      '>',
      '  Fixture Co',
      '</div>',
    ].join('\n');
    expect(substituteInSource(cls, ACME.names).text).toBe(cls.replace('Fixture Co', 'Acme Ltd'));
    const img = [
      '<img',
      '  srcSet="/fixture-1x.png 1x,',
      '  /fixture-2x.png 2x"',
      '  alt="Fixture Co"',
      '/>',
    ].join('\n');
    expect(substituteInSource(img, ACME.names).text).toBe(img.replace('Fixture Co', 'Acme Ltd'));
  });

  it('fences a broken import, a re-export, a srcSet and a className expression', () => {
    // prettier breaks a long import over three lines, so the path is not on the keyword's line
    const lines = [
      'import {',
      '  S02HeroFixture,',
      "} from '@/features/fixture/components/s02-hero-fixture';",
      "export { A, B } from '@/features/fixture/x';",
      '<img srcSet="/fixture-2x.png 2x" alt="Fixture Co" />',
      "<div className={cn({ active }, 'fixture-card')}>Fixture Co</div>",
    ];
    const r = substituteInSource(lines.join('\n'), ACME.names);
    expect(r.text).toBe(
      [
        ...lines.slice(0, 4),
        '<img srcSet="/fixture-2x.png 2x" alt="Acme Ltd" />',
        "<div className={cn({ active }, 'fixture-card')}>Acme Ltd</div>",
      ].join('\n'),
    );
    expect(r.counts).toEqual({ 'Fixture Co': 2 });
  });
});

describe('resolveAsset and replaceLogos', () => {
  async function project(name: string, assets: Record<string, string>): Promise<string> {
    const dir = path.join(root, name);
    await fs.mkdir(path.join(dir, 'src', 'assets', 'fonts'), { recursive: true });
    for (const [file, bytes] of Object.entries(assets))
      await fs.writeFile(path.join(dir, 'src', 'assets', file), bytes);
    return dir;
  }

  it('takes the file by its own name, else by the one name that ends in it', async () => {
    const p = await project('assets-one', {
      'image-abc-hero.png': 'old',
      'image-def-logo.png': 'old',
    });
    expect(await resolveAsset(p, 'image-abc-hero.png')).toBe(
      path.join(p, 'src', 'assets', 'image-abc-hero.png'),
    );
    expect(await resolveAsset(p, 'hero.png')).toBe(
      path.join(p, 'src', 'assets', 'image-abc-hero.png'),
    );
    await expect(resolveAsset(p, 'nope.png')).rejects.toThrow(
      /nothing under src\/assets is nope\.png/,
    );
    const two = await project('assets-two', {
      'image-abc-hero.png': 'old',
      'image-def-hero.png': 'old',
    });
    await expect(resolveAsset(two, 'hero.png')).rejects.toThrow(/names 2 files under src\/assets/);
  });

  it('names the dir when src/assets is there but cannot be read', async () => {
    const dir = path.join(root, 'assets-unreadable');
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    // a file where the dir should be: readdir answers ENOTDIR, which is not "nothing matches"
    await fs.writeFile(path.join(dir, 'src', 'assets'), 'not a dir');
    await expect(resolveAsset(dir, 'hero.png')).rejects.toThrow(/cannot read .*assets: /);
  });

  it('copies the brand bytes in under the asset name, once, and keeps the format', async () => {
    const file = await brandDir('logos', ACME);
    const loaded = await loadBrand(file);
    const p = await project('assets-replace', { 'image-abc-hero.png': 'old' });
    const first = await replaceLogos(p, loaded);
    expect(first).toEqual({
      replaced: [{ file: 'src/assets/image-abc-hero.png', from: 'logo.png' }],
      unchanged: [],
    });
    expect(await fs.readFile(path.join(p, 'src', 'assets', 'image-abc-hero.png'), 'utf8')).toBe(
      'acme logo',
    );
    // the second run finds its own bytes
    expect(await replaceLogos(p, loaded)).toEqual({
      replaced: [],
      unchanged: [{ file: 'src/assets/image-abc-hero.png', from: 'logo.png' }],
    });
    const svg = await loadBrand(
      await brandDir('logos-svg', { ...ACME, logos: { 'hero.png': 'logo.svg' } }),
    );
    await expect(replaceLogos(p, svg)).rejects.toThrow(/hero\.png is \.png and logo\.svg is \.svg/);
  });
});

describe('applyNames', () => {
  it('writes only the files a name landed in, and finds nothing the second time', async () => {
    const p = path.join(root, 'names');
    const hero = path.join(p, 'src', 'features', 'index', 'components', 's02-hero-fixture.tsx');
    const paths = path.join(p, 'src', 'config', 'paths.ts');
    const css = path.join(p, 'src', 'styles', 'globals.css');
    await fs.mkdir(path.dirname(hero), { recursive: true });
    await fs.mkdir(path.dirname(paths), { recursive: true });
    await fs.mkdir(path.dirname(css), { recursive: true });
    await fs.writeFile(
      hero,
      'import x from \'@/assets/fixture.png\';\n<h1 data-section="s02-hero-fixture">Fixture Co</h1>\n',
    );
    await fs.writeFile(paths, "export const paths = { home: { getHref: () => '/' } } as const;\n");
    await fs.writeFile(css, '/* Fixture Co */\n');
    const before = await fs.stat(paths);
    const r = await applyNames(p, ACME.names);
    expect(r).toEqual({
      counts: { 'Fixture Co': 1, Fixture: 0 },
      files: { 'src/features/index/components/s02-hero-fixture.tsx': 1 },
    });
    expect(await fs.readFile(hero, 'utf8')).toBe(
      'import x from \'@/assets/fixture.png\';\n<h1 data-section="s02-hero-fixture">Acme Ltd</h1>\n',
    );
    // a file with no name in it is not rewritten, and a css file is not a source file
    expect((await fs.stat(paths)).mtimeMs).toBe(before.mtimeMs);
    expect(await fs.readFile(css, 'utf8')).toBe('/* Fixture Co */\n');
    expect(await applyNames(p, ACME.names)).toEqual({
      counts: { 'Fixture Co': 0, Fixture: 0 },
      files: {},
    });
    expect(await applyNames(p, {})).toEqual({ counts: {}, files: {} });
  });

  it('passes over a symlink, the way the snapshot does', async () => {
    const p = path.join(root, 'names-symlink');
    const dir = path.join(p, 'src', 'features');
    await fs.mkdir(dir, { recursive: true });
    const outside = path.join(root, 'outside-source.tsx');
    await fs.writeFile(outside, '<h1>Fixture Co</h1>\n');
    await fs.symlink(outside, path.join(dir, 'link.tsx'));
    // the walker and the snapshot agree on what a file is, so nothing is rewritten that the
    // change list could not see and prettier would never reach
    expect(await applyNames(p, ACME.names)).toEqual({
      counts: { 'Fixture Co': 0, Fixture: 0 },
      files: {},
    });
    expect(await fs.readFile(outside, 'utf8')).toBe('<h1>Fixture Co</h1>\n');
    expect([...(await snapshotTree(p)).keys()]).toEqual([]);
  });
});

describe('packTheme and writeTheme over the synth pack', () => {
  it('reads back what generateFromPack would write', async () => {
    const pack = path.join(root, 'synth-pack');
    await synthPack(pack);
    const t = await packTheme(pack);
    expect(t.tokens).toEqual({
      colors: {
        'pack-000000-50': 'rgba(0, 0, 0, 0.5)',
        'pack-111827': '#111827',
        'pack-1f2937': '#1f2937',
        'pack-2563eb': '#2563eb',
      },
      fontFamily: { arial: ['Arial'], fixture: ['Fixture'] },
      keyframes: { fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } } },
      animation: { fadeIn: 'fadeIn 0.3s ease-out 0s 1 normal forwards' },
    });
    expect(t.fonts).toEqual([
      { family: 'Fixture', weight: '400', style: 'normal', file: 'font-abc-Fixture-Regular.woff2' },
    ]);
  });

  it('reads back the very theme generateFromPack wrote, not a copy of it', async () => {
    const pack = path.join(root, 'synth-pack-round-trip');
    await synthPack(pack);
    // synthPack indexes two assets but writes no bytes, and the generator copies real files
    const assets = new PackPaths(pack).assetsDir(new PackPaths(pack).pageDir('index'));
    for (const name of ['font-abc-Fixture-Regular.woff2', 'image-def-hero.png']) {
      await fs.writeFile(path.join(assets, name), name);
    }
    const project = path.join(root, 'round-trip-project');
    const generated = await generateFromPack({ root: pack, project });
    const t = await packTheme(pack);
    // pinned against the generator itself: the two readers drift apart, the literal above does not
    expect(t.tokens).toEqual(generated.tokens);
    expect(generated.fonts).toEqual(t.fonts.map((f) => `src/assets/fonts/${f.file}`));
  });

  it('keeps the pack face order, so a brand with no font override leaves fonts.css alone', async () => {
    const pack = path.join(root, 'synth-pack-face-order');
    await synthPack(pack);
    const pageDir = new PackPaths(pack).pageDir('index');
    const metaFile = path.join(pageDir, 'meta.json');
    const meta = JSON.parse(await fs.readFile(metaFile, 'utf8')) as {
      fonts: Record<string, unknown>[];
    };
    // two faces whose capture order is not their sorted order: the scaffold writes them as the
    // pack yields them, and the brand phase has to write the same file back
    const face = (family: string, file: string) => ({
      family,
      weight: '400',
      style: 'normal',
      status: 'loaded',
      file,
      url: `https://synth.example/fonts/${file}`,
    });
    meta.fonts = [face('Zeta', 'font-zzz-Zeta.woff2'), face('Alpha', 'font-aaa-Alpha.woff2')];
    await writeJson(metaFile, meta);
    const assets = new PackPaths(pack).assetsDir(pageDir);
    for (const name of ['font-zzz-Zeta.woff2', 'font-aaa-Alpha.woff2', 'image-def-hero.png']) {
      await fs.writeFile(path.join(assets, name), name);
    }
    const project = path.join(root, 'face-order-project');
    await generateFromPack({ root: pack, project });
    const cssFile = path.join(project, 'src', 'styles', 'fonts.css');
    const scaffolded = await fs.readFile(cssFile);
    expect(scaffolded.toString()).toMatch(/Zeta[\s\S]*Alpha/);
    const loaded = await loadBrand(await brandDir('face-order-brand', EMPTY));
    const r = await writeTheme(project, pack, loaded);
    expect(r.copied).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(await fs.readFile(cssFile)).toEqual(scaffolded);
  });

  it('writes the theme and the faces with the brand layered over, and reports what moved', async () => {
    const pack = path.join(root, 'synth-pack-theme');
    await synthPack(pack);
    const project = path.join(root, 'theme-project');
    const fontsDir = path.join(project, 'src', 'assets', 'fonts');
    await fs.mkdir(fontsDir, { recursive: true });
    await fs.writeFile(path.join(fontsDir, 'font-abc-Fixture-Regular.woff2'), 'source 400');
    const loaded = await loadBrand(
      await brandDir('theme-brand', { ...ACME, colors: { 'pack-2563eb': '#e11d48' } }),
    );
    const r = await writeTheme(project, pack, loaded);
    expect(r).toEqual({
      colors: [{ token: 'pack-2563eb', from: '#2563eb', to: '#e11d48' }],
      fonts: [
        {
          source: 'Fixture',
          family: 'Acme Sans',
          faces: [
            { family: 'Acme Sans', weight: '400', style: 'normal', file: 'Acme-Regular.woff2' },
          ],
        },
      ],
      copied: ['src/assets/fonts/Acme-Regular.woff2'],
      removed: ['src/assets/fonts/font-abc-Fixture-Regular.woff2'],
    });
    const tailwind = require(path.join(project, 'tailwind.config.cjs'));
    expect(tailwind.theme.extend.colors).toEqual({
      'pack-000000-50': 'rgba(0, 0, 0, 0.5)',
      'pack-111827': '#111827',
      'pack-1f2937': '#1f2937',
      'pack-2563eb': '#e11d48',
    });
    expect(tailwind.theme.extend.fontFamily).toEqual({ arial: ['Arial'], fixture: ['Acme Sans'] });
    expect(tailwind.theme.extend.animation.fadeIn).toBe(
      'fadeIn 0.3s ease-out 0s 1 normal forwards',
    );
    const css = await fs.readFile(path.join(project, 'src', 'styles', 'fonts.css'), 'utf8');
    expect(css.match(/@font-face/g)).toHaveLength(1);
    expect(css).toContain("font-family: 'Acme Sans';");
    expect(css).not.toContain("'Fixture'");
    expect((await fs.readdir(fontsDir)).sort()).toEqual(['Acme-Regular.woff2']);
    // the second run: the same files, nothing copied, nothing removed
    const again = await writeTheme(project, pack, loaded);
    expect(again.copied).toEqual([]);
    expect(again.removed).toEqual([]);
    expect(await fs.readFile(path.join(project, 'src', 'styles', 'fonts.css'), 'utf8')).toBe(css);
  });
});

describe('snapshotTree and diffTrees', () => {
  it('sees nothing between a tree and itself, and names a changed, an added and a removed file', async () => {
    const p = path.join(root, 'tree');
    await fs.mkdir(path.join(p, 'src', 'a'), { recursive: true });
    await fs.writeFile(path.join(p, 'src', 'a', 'one.tsx'), 'one');
    await fs.writeFile(path.join(p, 'src', 'two.css'), 'two');
    await fs.writeFile(path.join(p, 'tailwind.config.cjs'), 'cfg');
    await fs.writeFile(path.join(p, 'deviations.md'), 'not part of the tree');
    const before = await snapshotTree(p);
    expect([...before.keys()].sort()).toEqual([
      'src/a/one.tsx',
      'src/two.css',
      'tailwind.config.cjs',
    ]);
    // the no-op negative
    expect(diffTrees(before, await snapshotTree(p))).toEqual([]);
    await fs.writeFile(path.join(p, 'src', 'a', 'one.tsx'), 'uno');
    await fs.writeFile(path.join(p, 'src', 'three.ts'), 'three');
    await fs.rm(path.join(p, 'src', 'two.css'));
    expect(diffTrees(before, await snapshotTree(p))).toEqual([
      'src/a/one.tsx',
      'src/three.ts',
      'src/two.css',
    ]);
  });
});

describe('familyLeftovers', () => {
  it('finds nothing without a font override, and names a quoted family with its line', async () => {
    const p = path.join(root, 'leftovers');
    const file = path.join(p, 'src', 'features', 'x', 'components', 'a.tsx');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      'export const A = () => <p className="font-[\'Fixture\']">Fixture Co</p>;\n',
    );
    await fs.mkdir(path.join(p, 'src', 'styles'), { recursive: true });
    await fs.writeFile(
      path.join(p, 'src', 'styles', 'extra.css'),
      '.x {\n  font-family: "Fixture";\n}\n',
    );
    // the no-op negative: no family overridden, nothing to look for
    expect(await familyLeftovers(p, { ...ACME, fonts: {} })).toEqual([]);
    expect(await familyLeftovers(p, ACME)).toEqual([
      { family: 'Fixture', file: 'src/features/x/components/a.tsx', line: 1 },
      { family: 'Fixture', file: 'src/styles/extra.css', line: 2 },
    ]);
  });
});

describe('deviationsText', () => {
  it('writes every section, the empty ones saying so', () => {
    const manifest = {
      units: {
        'page:index': { status: 'passed' },
        'page:index#s01-header': { status: 'passed' },
        'page:about': { status: 'blocked' },
      },
    } as unknown as Parameters<typeof deviationsText>[0]['manifest'];
    const text = deviationsText({
      brandFile: '/b/brand.json',
      project: '/p',
      root: '/r',
      at: '2026-09-20T10:00:00.000Z',
      run: 'brand-2026-09-20T10-00-00',
      manifest,
      brand: ACME,
      changed: ['src/styles/fonts.css', 'tailwind.config.cjs'],
      theme: {
        colors: [{ token: 'pack-2563eb', from: '#2563eb', to: '#e11d48' }],
        fonts: [
          {
            source: 'Fixture',
            family: 'Acme Sans',
            faces: [
              { family: 'Acme Sans', weight: '400', style: 'normal', file: 'Acme-Regular.woff2' },
            ],
          },
        ],
        copied: ['src/assets/fonts/Acme-Regular.woff2'],
        removed: ['src/assets/fonts/font-a-Fixture-Regular.woff2'],
      },
      logos: {
        replaced: [{ file: 'src/assets/image-a-hero.png', from: 'logo.png' }],
        unchanged: [],
      },
      names: {
        counts: { 'Fixture Co': 3, Fixture: 0 },
        files: { 'src/components/layouts/site-header.tsx': 3 },
      },
      leftovers: [{ family: 'Fixture', file: 'src/x.tsx', line: 4 }],
      gate: {
        verdict: 'fail',
        units: [
          { unitId: 'page:about', findings: [] },
          {
            unitId: 'page:index',
            findings: [
              { kind: 'button', expected: 'Scanner', actual: '(missing)', where: 's01-header' },
            ],
          },
        ],
        skipped: [{ unitId: 'page:shape', reason: 'no sections.json' }],
      },
    });
    expect(text).toBe(
      [
        '# brand: /b/brand.json',
        '',
        '- project: /p',
        '- pack: /r',
        '- applied: 2026-09-20T10:00:00.000Z',
        '- run: runs/brand-2026-09-20T10-00-00',
        '- phase one: 2 of 3 units passed, 1 blocked',
        '- files changed: 2',
        '  - src/styles/fonts.css',
        '  - tailwind.config.cjs',
        '',
        '## theme',
        '',
        '- colour pack-2563eb: #2563eb -> #e11d48',
        '- family Fixture -> Acme Sans: faces Acme-Regular.woff2 (400 normal)',
        '- removed src/assets/fonts/font-a-Fixture-Regular.woff2',
        '',
        '## logos',
        '',
        '- src/assets/image-a-hero.png <- logo.png',
        '',
        '## names',
        '',
        '- Fixture Co -> Acme Ltd: 3',
        '- Fixture -> Acme: 0',
        '  - src/components/layouts/site-header.tsx: 3',
        '',
        '## left for you',
        '',
        '- src/x.tsx:4 still names the family Fixture',
        '',
        '## structure gate (brand normalisation on)',
        '',
        '- page:about: pass',
        '- page:index: fail',
        '  - button @ s01-header: expected Scanner, got (missing)',
        '- page:shape: skipped, no sections.json',
        '',
        'verdict: fail',
        '',
      ].join('\n'),
    );
    const empty = deviationsText({
      brandFile: '/b/brand.json',
      project: '/p',
      root: '/r',
      at: 'now',
      run: 'brand-x',
      manifest: { units: {} } as unknown as Parameters<typeof deviationsText>[0]['manifest'],
      brand: EMPTY,
      changed: [],
      theme: { colors: [], fonts: [], copied: [], removed: [] },
      logos: { replaced: [], unchanged: [] },
      names: { counts: {}, files: {} },
      leftovers: [],
      gate: { verdict: 'pass', units: [], skipped: [] },
    });
    for (const line of [
      '- phase one: 0 of 0 units passed, 0 blocked',
      '- files changed: 0',
      '- nothing overridden',
      '## logos\n\n- none',
      '## names\n\n- none',
      '## left for you\n\n- nothing',
      'verdict: pass',
    ])
      expect(empty, line).toContain(line);
  });
});

describe('brandProject before it writes and when a codemod step throws', () => {
  /** the four things a rebuild has, so the project check lets the codemod run */
  async function rebuildShell(name: string): Promise<string> {
    const project = path.join(root, name);
    await fs.mkdir(path.join(project, 'src', 'app'), { recursive: true });
    await fs.mkdir(path.join(project, 'src', 'styles'), { recursive: true });
    await fs.writeFile(path.join(project, 'package.json'), '{ "name": "x-rebuild" }\n');
    await fs.writeFile(path.join(project, 'tailwind.config.cjs'), 'module.exports = {};\n');
    return project;
  }

  it('refuses a project that is not a rebuild, naming what is missing, and writes nothing', async () => {
    const pack = path.join(root, 'synth-pack-not-a-rebuild');
    await synthPack(pack);
    const loaded = await loadBrand(await brandDir('not-a-rebuild-brand', ACME));
    const project = path.join(root, 'not-a-rebuild');
    await fs.mkdir(project, { recursive: true });
    await expect(
      brandProject({
        root: pack,
        project,
        brandFile: loaded.file,
        target: 'http://127.0.0.1:1',
        log: () => {},
        gate: () => Promise.reject(new Error('the gate is never reached')),
      }),
    ).rejects.toThrow(/is not a rebuild: no package\.json, no tailwind\.config\.cjs, no src/);
    expect(await fs.readdir(project)).toEqual([]);
  });

  it('writes deviations.md naming the step that threw and what had landed before it', async () => {
    const pack = path.join(root, 'synth-pack-codemod-throw');
    await synthPack(pack);
    // no src/assets at all, so the logo key resolves to nothing and replaceLogos throws after
    // writeTheme has already rewritten the config and the faces
    const project = await rebuildShell('codemod-throw');
    const loaded = await loadBrand(await brandDir('codemod-throw-brand', ACME));
    await expect(
      brandProject({
        root: pack,
        project,
        brandFile: loaded.file,
        target: 'http://127.0.0.1:1',
        log: () => {},
        gate: () => Promise.reject(new Error('the gate is never reached')),
      }),
    ).rejects.toThrow(/nothing under src\/assets is hero\.png/);
    const report = await fs.readFile(path.join(project, 'deviations.md'), 'utf8');
    expect(report).toContain('- the logo copy did not finish: brand.json logos: nothing under');
    expect(report).toContain('verdict: error');
    // what the theme step had written by then, by bytes, and what it says it wrote
    expect(report).toContain('- files changed: 3');
    expect(report).toContain('  - src/assets/fonts/Acme-Regular.woff2');
    expect(report).toContain('  - src/styles/fonts.css');
    expect(report).toContain('  - tailwind.config.cjs');
    expect(report).toContain('- colour pack-2563eb: #2563eb -> #e11d48');
  });
});

describe('brandProject when the gate throws', () => {
  it('still writes deviations.md, with the failure under the gate section, and raises the error again', async () => {
    const pack = path.join(root, 'synth-pack-gate');
    await synthPack(pack);
    const project = path.join(root, 'gate-project');
    const fontsDir = path.join(project, 'src', 'assets', 'fonts');
    await fs.mkdir(fontsDir, { recursive: true });
    await fs.writeFile(path.join(fontsDir, 'font-abc-Fixture-Regular.woff2'), 'source 400');
    await fs.writeFile(path.join(project, 'src', 'assets', 'image-abc-hero.png'), 'old');
    // the rest of the shell brandProject checks for before it writes anything (writeTheme
    // below makes the other two)
    await fs.mkdir(path.join(project, 'src', 'app'), { recursive: true });
    await fs.writeFile(path.join(project, 'package.json'), '{ "name": "x-rebuild" }\n');
    const loaded = await loadBrand(await brandDir('gate-brand', ACME));
    // the codemod first, so the run below finds nothing to change and never reaches the
    // project's own prettier: a unit-test project has no node_modules to find one in
    await writeTheme(project, pack, loaded);
    await replaceLogos(project, loaded);
    const lines: string[] = [];
    await expect(
      brandProject({
        root: pack,
        project,
        brandFile: loaded.file,
        target: 'http://127.0.0.1:1',
        log: (l) => lines.push(l),
        gate: () => Promise.reject(new Error('the browser would not open')),
      }),
    ).rejects.toThrow(/the browser would not open/);
    expect(lines).toContain('0 files changed');
    const report = await fs.readFile(path.join(project, 'deviations.md'), 'utf8');
    expect(report).toContain('- the gate did not finish: the browser would not open');
    expect(report).toContain('verdict: error');
    // the run dir it names is the one this run took in the pack
    const runs = (await fs.readdir(path.join(pack, 'runs'))).filter((n) => n.startsWith('brand-'));
    expect(runs).toHaveLength(1);
    expect(report).toContain(`- run: runs/${runs[0]}`);
    expect(report).toContain(`- its run dir is runs/${runs[0]}`);
    // and what the codemod did is in it all the same
    expect(report).toContain('- colour pack-2563eb: #2563eb -> #e11d48');
    expect(report).toContain('- src/assets/image-abc-hero.png: already logo.png');
  });
});
