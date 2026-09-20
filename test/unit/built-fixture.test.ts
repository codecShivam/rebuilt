import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PNG } from 'pngjs';
import { format } from 'prettier';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJson } from '../../src/pack/io';
import { BrandSchema } from '../../src/pack/schemas';
import { builtIndexFiles, writeBuiltIndex } from '../helpers/built-fixture';

const BRAND_DIR = path.resolve('test/fixtures/brand');
const SCAFFOLD = path.resolve('test/fixtures/scaffold/nextjs-app');
let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-built-fixture-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('the fixture brand sample', () => {
  it('parses, names the fixture as captured, and its files are there', async () => {
    const brand = await readJson(BrandSchema, path.join(BRAND_DIR, 'brand.json'));
    expect(brand.names).toEqual({
      'Fixture Co': 'Acme Ltd',
      Scanner: 'Acme Scan',
      Monitor: 'Acme Watch',
    });
    expect(brand.logos).toEqual({ 'hero.png': 'logo.png' });
    expect(brand.colors).toEqual({ 'pack-2563eb': '#e11d48', 'pack-111827': '#0f172a' });
    expect(Object.keys(brand.fonts)).toEqual(['Fixture']);
    expect(brand.fonts['Fixture']!.family).toBe('Acme Sans');
    expect(brand.fonts['Fixture']!.faces.map((f) => [f.file, f.weight])).toEqual([
      ['fonts/Acme-Regular.woff2', '400'],
      ['fonts/Acme-Bold.woff2', '700'],
    ]);
    const logo = PNG.sync.read(await fs.readFile(path.join(BRAND_DIR, 'logo.png')));
    expect([logo.width, logo.height]).toEqual([480, 270]);
    // not the fixture's hero: a replaced logo is told apart by bytes
    expect(await fs.readFile(path.join(BRAND_DIR, 'logo.png'))).not.toEqual(
      await fs.readFile(path.resolve('test/fixtures/site/hero.png')),
    );
    const inter = await fs.readFile(path.resolve('test/fixtures/site/fonts/Fixture-Regular.woff2'));
    for (const face of brand.fonts['Fixture']!.faces)
      expect(await fs.readFile(path.join(BRAND_DIR, face.file)), face.file).toEqual(inter);
  });
});

describe('the fixture index rebuilt by hand', () => {
  it('is in the shape the project’s own prettier prints', async () => {
    const options = {
      ...(JSON.parse(await fs.readFile(path.join(SCAFFOLD, '.prettierrc'), 'utf8')) as object),
      parser: 'typescript' as const,
    };
    const files = builtIndexFiles('image-abc-hero.png');
    expect(Object.keys(files).sort()).toEqual([
      'src/components/layouts/site-footer.tsx',
      'src/components/layouts/site-header.tsx',
      'src/features/index/components/s02-hero-know-before-you-go.tsx',
      'src/features/index/components/s03-features-everything-you-need.tsx',
      'src/features/index/components/s04-faq-questions.tsx',
      'src/features/index/components/s05-cta-ready-when-you-are.tsx',
    ]);
    for (const [rel, text] of Object.entries(files)) {
      expect(await format(text, options), rel).toBe(text);
    }
    // the words the gate and the brand sample lean on
    const header = files['src/components/layouts/site-header.tsx']!;
    for (const word of ['Fixture Co', 'aria-label="Menu"', 'Products', 'Scanner', 'Monitor'])
      expect(header, word).toContain(word);
    expect(files['src/features/index/components/s02-hero-know-before-you-go.tsx']).toContain(
      "import hero from '@/assets/image-abc-hero.png';",
    );
  });

  it('writes over a scaffold that has the hero asset, and refuses one that has not', async () => {
    const project = path.join(root, 'project');
    await fs.mkdir(path.join(project, 'src', 'assets'), { recursive: true });
    await expect(writeBuiltIndex(project)).rejects.toThrow(/has no \*-hero\.png/);
    await fs.writeFile(path.join(project, 'src', 'assets', 'image-37e12319-hero.png'), 'png');
    const written = await writeBuiltIndex(project);
    expect(written).toHaveLength(6);
    for (const rel of written)
      await expect(fs.stat(path.join(project, rel)), rel).resolves.toBeTruthy();
    expect(
      await fs.readFile(
        path.join(project, 'src/features/index/components/s02-hero-know-before-you-go.tsx'),
        'utf8',
      ),
    ).toContain("import hero from '@/assets/image-37e12319-hero.png';");
  });
});
