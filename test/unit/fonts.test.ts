import { describe, it, expect } from 'vitest';
import { mapFonts, uniqueFaces, weightRange } from '../../src/capture/fonts';

const FACES = [
  {
    family: 'Fixture',
    weight: '400',
    style: 'normal',
    urls: ['http://x.test/fonts/Fixture-Regular.woff2'],
  },
  {
    family: 'Fixture',
    weight: '700',
    style: '',
    urls: ['http://x.test/fonts/a1b2c3d4e5.woff2#iefix'],
  },
  {
    family: '"Inter"',
    weight: '100 900',
    style: 'italic',
    urls: ['http://x.test/fonts/inter.woff2'],
  },
];
const files: Record<string, string> = {
  'http://x.test/fonts/Fixture-Regular.woff2': 'font-1-Fixture-Regular.woff2',
  'http://x.test/fonts/a1b2c3d4e5.woff2': 'font-2-a1b2c3d4e5.woff2',
  'http://x.test/fonts/inter.woff2': 'font-3-inter.woff2',
};
const fileFor = (url: string) => files[url] ?? null;

describe('mapFonts', () => {
  it('maps nothing when no face declares the family', () => {
    expect(
      mapFonts(
        [{ family: 'Nope', weight: '400', style: 'normal', status: 'loaded' }],
        FACES,
        fileFor,
      ),
    ).toEqual([
      { family: 'Nope', weight: '400', style: 'normal', status: 'loaded', file: null, url: null },
    ]);
  });

  it('maps a family and weight to its file through the face src, whatever the file is called', () => {
    const r = mapFonts(
      [
        { family: '"Fixture"', weight: '400', style: 'normal', status: 'loaded' },
        { family: '"Fixture"', weight: '700', style: 'normal', status: 'loaded' },
      ],
      FACES,
      fileFor,
    );
    expect(r.map((f) => f.file)).toEqual([
      'font-1-Fixture-Regular.woff2',
      'font-2-a1b2c3d4e5.woff2',
    ]);
    expect(r[1]!.url).toBe('http://x.test/fonts/a1b2c3d4e5.woff2#iefix');
    expect(r[0]!.family).toBe('Fixture');
  });

  it('matches a weight inside a variable range and a style by its first word', () => {
    const italic = { family: 'Inter', weight: '600', style: 'italic', status: 'loaded' };
    expect(mapFonts([italic], FACES, fileFor)[0]!.file).toBe('font-3-inter.woff2');
    const upright = { ...italic, style: 'normal' };
    expect(mapFonts([upright], FACES, fileFor)[0]!.file).toBeNull();
  });

  it('reads weight descriptors as ranges', () => {
    expect(weightRange('bold')).toEqual([700, 700]);
    expect(weightRange('normal')).toEqual([400, 400]);
    expect(weightRange('')).toEqual([400, 400]);
    expect(weightRange('100 900')).toEqual([100, 900]);
    expect(weightRange('500')).toEqual([500, 500]);
  });
});

describe('uniqueFaces', () => {
  it('keeps one face per family, weight, style and sources', () => {
    const a = { family: 'Fixture', weight: '400', style: 'normal', urls: ['http://x/a.woff2'] };
    expect(uniqueFaces([])).toEqual([]);
    expect(
      uniqueFaces([a, { ...a }, { ...a, weight: '700' }, { ...a, urls: ['http://x/b.woff2'] }]),
    ).toEqual([a, { ...a, weight: '700' }, { ...a, urls: ['http://x/b.woff2'] }]);
  });
});
