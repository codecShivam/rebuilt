import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Session } from '../../src/capture/session';
import { readJson, writeJson } from '../../src/pack/io';
import { BrandSchema, COLOUR_TOKEN, COLOUR_VALUE, type Brand } from '../../src/pack/schemas';
import {
  BrandCollisionError,
  gateStructure,
  sourceColourOf,
  substitute,
  unbrand,
} from '../../src/verify/brand';
import { synthPack } from '../helpers/pack';

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-brand-shape-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const BRAND: Brand = {
  names: { 'Fixture Co': 'Acme Ltd', Scanner: 'Acme Scan', Monitor: 'Acme Watch' },
  logos: { 'hero.png': 'logo.png' },
  colors: { 'pack-2563eb': '#e11d48', 'pack-000000-50': 'rgba(10, 20, 30, 0.5)' },
  fonts: {
    Fixture: {
      family: 'Acme Sans',
      faces: [{ file: 'fonts/Acme-Regular.woff2', weight: '400', style: 'normal' }],
    },
  },
};

describe('brand.json', () => {
  /** writes `value` as <name>.json and asserts readJson refuses it with a message matching `where` */
  const bad = async (name: string, value: unknown, where: RegExp) => {
    const file = path.join(root, `${name}.json`);
    await writeJson(file, value);
    await expect(readJson(BrandSchema, file), name).rejects.toThrow(where);
  };

  it('reads a valid brand back as it was written', async () => {
    const file = path.join(root, 'ok.json');
    await writeJson(file, BRAND);
    expect(await readJson(BrandSchema, file)).toEqual(BRAND);
  });

  it('names the field of a bad token, a bad colour, a bad face and a case-only name pair', async () => {
    await bad('token', { ...BRAND, colors: { 'pack-2563EB': '#fff' } }, /schema failure at colors/);
    await bad('colour', { ...BRAND, colors: { 'pack-2563eb': 'red' } }, /schema failure at colors/);
    await bad(
      'face',
      { ...BRAND, fonts: { Fixture: { family: 'Acme Sans', faces: [] } } },
      /schema failure at fonts\.Fixture\.faces/,
    );
    await bad(
      'case',
      { ...BRAND, names: { Fixture: 'Acme', FIXTURE: 'ACME' } },
      /schema failure at names: two names differ only by case/,
    );
    await bad('extra', { ...BRAND, slogan: 'x' }, /schema failure at/);
    await bad('missing', { names: {} }, /schema failure at/);
  });

  it('refuses two brand strings that differ only by case, within a field and across fields', async () => {
    // unbrand inverts the brand, and the match is case-insensitive, so `Acme` and `ACME` would
    // both come back as whichever of Alpha and Beta the table took first and the other would
    // be dropped without a word
    await bad(
      'brand-case',
      { ...BRAND, names: { Alpha: 'Acme', Beta: 'ACME' } },
      /schema failure at names: two brand strings differ only by case: "Acme" and "ACME"/,
    );
    await bad(
      'brand-case-across-fields',
      { ...BRAND, names: { Alpha: 'acme sans' } },
      /schema failure at fonts: two brand strings differ only by case: "acme sans" and "Acme Sans"/,
    );
  });

  it('refuses a brand string that carries a source name, and a chain of them', async () => {
    // the no-op negative: no brand string in the sample carries a source name, so a second
    // run finds nothing left to rewrite
    const file = path.join(root, 'contains-none.json');
    await writeJson(file, BRAND);
    expect(await readJson(BrandSchema, file)).toEqual(BRAND);
    await bad(
      'contains',
      { ...BRAND, names: { ...BRAND.names, Scanner: 'Acme Scanner' } },
      /schema failure at names: Scanner is branded "Acme Scanner", which carries the source name Scanner/,
    );
    await bad(
      'chain',
      { ...BRAND, names: { A: 'B', B: 'C' } },
      /schema failure at names: A is branded "B", which is the source name B/,
    );
  });

  it('spells a token and a colour the way tokensFrom and css do', () => {
    for (const ok of ['pack-2563eb', 'pack-000000-50', 'pack-ffffff-100'])
      expect(COLOUR_TOKEN.test(ok), ok).toBe(true);
    for (const bad of ['pack-2563EB', 'pack-25', 'brand-2563eb', 'pack-2563eb-'])
      expect(COLOUR_TOKEN.test(bad), bad).toBe(false);
    for (const ok of [
      '#fff',
      '#ffff',
      '#e11d48',
      '#e11d4880',
      'rgb(1, 2, 3)',
      'rgb(100%, 0%, 0%)',
      'rgba(10, 20, 30, 0.5)',
      'rgba(0, 0, 0, .5)',
      'rgba(0, 0, 0, 1)',
      'hsla(1, 2%, 3%, 0.5)',
    ])
      expect(COLOUR_VALUE.test(ok), ok).toBe(true);
    // an rgb body is numbers and an alpha between zero and one, not anything in brackets
    for (const bad of [
      'red',
      '#ggg',
      'rgb()',
      '#e11d4',
      '',
      'rgb(zzz)',
      'rgb(1, 2)',
      'rgba(1, 2, 3, 5)',
    ])
      expect(COLOUR_VALUE.test(bad), bad).toBe(false);
  });
});

describe('gateStructure over pages it cannot compare', () => {
  it('names a page with no url and a page with no sections.json, each with its reason', async () => {
    // a pack whose every page unit is skipped: the gate opens no browser, so the session is
    // never touched. the other side (nothing skipped at all) is the integration test's
    const session = {} as unknown as Session;
    const pack = path.join(root, 'gate-pack');
    await synthPack(pack);
    const file = path.join(pack, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as {
      units: Record<string, Record<string, unknown>>;
    };
    delete manifest.units['page:index']!.url;
    manifest.units['page:shape'] = {
      kind: 'page',
      status: 'blocked',
      url: 'https://synth.example/shape',
      dependsOn: [],
      rounds: 0,
      updatedAt: '2026-09-20T10:00:00.000Z',
    };
    await writeJson(file, manifest);
    expect(
      await gateStructure({ root: pack, target: 'http://127.0.0.1:1', session, brand: null }),
    ).toEqual({
      verdict: 'pass',
      units: [],
      skipped: [
        { unitId: 'page:index', reason: 'no url' },
        { unitId: 'page:shape', reason: 'no sections.json' },
      ],
    });
  });
});

describe('substitute', () => {
  it('leaves text alone with an empty table, and with a table that never matches', () => {
    // the no-op negative
    expect(substitute('Fixture Co checks every detail.', {})).toEqual({
      text: 'Fixture Co checks every detail.',
      counts: {},
    });
    expect(substitute('Fixture Co checks every detail.', { Acme: 'Zed' })).toEqual({
      text: 'Fixture Co checks every detail.',
      counts: {},
    });
  });

  it('replaces whole words only, longest key first', () => {
    const table = { 'Fixture Co': 'Acme Ltd', Fixture: 'Acme' };
    const r = substitute('Fixture Co, a Fixture, FixtureHero, s02-fixture.', table);
    expect(r.text).toBe('Acme Ltd, a Acme, FixtureHero, s02-acme.');
    expect(r.counts).toEqual({ 'Fixture Co': 1, Fixture: 2 });
  });

  it('carries the case of the match: as written, lower, upper; anything else stays', () => {
    const table = { 'Fixture Co': 'Acme Ltd' };
    expect(substitute('Fixture Co', table).text).toBe('Acme Ltd');
    expect(substitute('fixture co', table).text).toBe('acme ltd');
    expect(substitute('FIXTURE CO', table).text).toBe('ACME LTD');
    const odd = substitute('Fixture co and fIXTURE cO', table);
    expect(odd.text).toBe('Fixture co and fIXTURE cO');
    expect(odd.counts).toEqual({});
  });

  it('escapes a key that carries regex characters', () => {
    expect(substitute('cost: $9.99 (intro)', { '$9.99 (intro)': '$0' }).text).toBe('cost: $0');
  });

  it('counts a combining mark as part of the word, so decomposed text is not split', () => {
    // decomposed, `Fixture` is followed or preceded by a bare combining acute, not by a letter.
    // 0xe9 is a precomposed e-acute, spelled by its code point so this file stays ascii and the
    // normalize call below is the only thing that splits it
    const eAcute = String.fromCharCode(0xe9);
    const trailing = `Fixtur${eAcute}`.normalize('NFD');
    const leading = `${eAcute}Fixture`.normalize('NFD');
    expect(substitute(trailing, { Fixture: 'Acme' })).toEqual({ text: trailing, counts: {} });
    expect(substitute(leading, { Fixture: 'Acme' })).toEqual({ text: leading, counts: {} });
  });
});

describe('sourceColourOf', () => {
  it('reads the source value out of the token name', () => {
    expect(sourceColourOf('pack-2563eb')).toBe('#2563eb');
    expect(sourceColourOf('pack-000000-50')).toBe('rgba(0, 0, 0, 0.5)');
    expect(sourceColourOf('pack-ff8000-33')).toBe('rgba(255, 128, 0, 0.33)');
    // the suffix is a percent, so -5 is five percent and not fifty
    expect(sourceColourOf('pack-000000-5')).toBe('rgba(0, 0, 0, 0.05)');
    expect(() => sourceColourOf('brand-2563eb')).toThrow(/not a pack colour token/);
  });
});

describe('unbrand', () => {
  const back = unbrand(BRAND);

  it('is the identity on text with nothing branded in it', () => {
    // the no-op negative
    expect(back('Know before you go')).toBe('Know before you go');
    expect(back('')).toBe('');
  });

  it('maps a name, a family and a colour back to the source', () => {
    expect(back('Acme Ltd checks every detail.')).toBe('Fixture Co checks every detail.');
    expect(back('Acme Scan | Acme Watch')).toBe('Scanner | Monitor');
    expect(back("font-family: 'Acme Sans'")).toBe("font-family: 'Fixture'");
    expect(back('color: #e11d48; background: rgba(10, 20, 30, 0.5)')).toBe(
      'color: #2563eb; background: rgba(0, 0, 0, 0.5)',
    );
  });

  it('comes back to the first of two source names that share a brand string', () => {
    const shared = unbrand({
      ...BRAND,
      names: { 'Fixture Co': 'Acme', 'Fixture Company': 'Acme' },
    });
    expect(shared('Acme')).toBe('Fixture Co');
  });

  it('builds a normaliser for the fixture sample and round-trips every brand string in it', () => {
    expect(() => unbrand(BRAND)).not.toThrow();
    for (const [source, branded] of Object.entries(BRAND.names)) expect(back(branded)).toBe(source);
    for (const [source, font] of Object.entries(BRAND.fonts))
      expect(back(font.family)).toBe(source);
    for (const [token, value] of Object.entries(BRAND.colors))
      expect(back(value)).toBe(sourceColourOf(token));
  });

  it('throws rather than drop one of two brand strings that differ only by case', () => {
    // the schema refuses this, but a hand-built table must not hide the collision either
    const colliding: Brand = { ...BRAND, names: { Alpha: 'Acme', Beta: 'ACME' } };
    expect(() => unbrand(colliding)).toThrow(BrandCollisionError);
    expect(() => unbrand(colliding)).toThrow(/"Acme" and "ACME"/);
    const across: Brand = { ...BRAND, names: { Alpha: 'acme sans' } };
    expect(() => unbrand(across)).toThrow(/"acme sans" and "Acme Sans"/);
  });
});
