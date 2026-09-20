import { describe, it, expect } from 'vitest';
import { compareStructure, matchSection } from '../../src/verify/structure';
import type { Section } from '../../src/pack/schemas';

function section(over: Partial<Section> & { id: string }): Section {
  return {
    id: over.id,
    order: over.order ?? 1,
    role: over.role ?? 'features',
    heading: over.heading ?? 'Everything you need',
    selector: over.selector ?? 'section.features',
    path: over.path ?? 'body>section:nth-of-type(1)',
    ref: over.ref ?? 'r00000001',
    dataSection: over.dataSection ?? null,
    bbox: over.bbox ?? { mobile: null, desktop: null },
    items: over.items ?? [],
    buttons: over.buttons ?? [],
    imageCount: over.imageCount ?? 0,
    svgCount: over.svgCount ?? 0,
  };
}

const ITEMS = [
  { title: 'Fast scans', description: 'Results in under a minute.', path: 'p1' },
  { title: 'Deep records', description: 'Two hundred sources.', path: 'p2' },
];

describe('compareStructure', () => {
  it('reports reordered items once, as an order finding', () => {
    const findings = compareStructure(
      [section({ id: 's02-features', items: ITEMS })],
      [section({ id: 's02-features', items: [ITEMS[1]!, ITEMS[0]!] })],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('item');
    expect(findings[0]!.where.endsWith('(order)')).toBe(true);
  });

  it('says nothing about order when the items match', () => {
    expect(
      compareStructure(
        [section({ id: 's02-features', items: ITEMS })],
        [section({ id: 's02-features', items: ITEMS })],
      ),
    ).toEqual([]);
  });

  it('reports a different section count against the page', () => {
    const findings = compareStructure(
      [
        section({ id: 's01-hero' }),
        section({ id: 's02-features', order: 2, path: 'body>section:nth-of-type(2)' }),
      ],
      [section({ id: 's01-hero' })],
    );
    const count = findings.find((f) => f.kind === 'count');
    expect(count).toMatchObject({ expected: '2 sections', actual: '1 sections', where: 'page' });
  });
});

describe('matchSection', () => {
  const source = section({
    id: 's02-hero',
    order: 2,
    path: 'body>main:nth-of-type(1)>section:nth-of-type(2)',
  });
  const sameOrder = section({ id: 'by-order', order: 2, path: 'body>div:nth-of-type(9)' });
  const samePath = section({ id: 'by-path', path: source.path });
  const declared = section({
    id: 'by-data',
    path: 'body>div:nth-of-type(4)',
    dataSection: 's02-hero',
  });

  it('prefers a declared data-section', () => {
    expect(matchSection(source, [sameOrder, samePath, declared])?.id).toBe('by-data');
  });
  it('falls back to an identical path', () => {
    expect(matchSection(source, [sameOrder, samePath])?.id).toBe('by-path');
  });
  it('falls back to the same order last', () => {
    expect(matchSection(source, [section({ id: 'first' }), sameOrder])?.id).toBe('by-order');
  });
});

describe('compareStructure with a normaliser', () => {
  const branded = section({
    id: 's02-features',
    heading: 'Everything Acme Ltd gives you',
    items: [{ title: 'Acme Scan', description: 'Scans by Acme Ltd.', path: 'p1' }],
    buttons: ['Try Acme Scan'],
  });
  const source = section({
    id: 's02-features',
    heading: 'Everything Fixture Co gives you',
    items: [{ title: 'Scanner', description: 'Scans by Fixture Co.', path: 'p1' }],
    buttons: ['Try Scanner'],
  });
  const back = (s: string) => s.replace(/Acme Ltd/g, 'Fixture Co').replace(/Acme Scan/g, 'Scanner');

  it('compares exactly without one, and the identity changes nothing', () => {
    // the no-op negative: the fourth argument absent is the fourth argument as the identity
    const without = compareStructure([source], [branded]);
    expect(without).toEqual(compareStructure([source], [branded], undefined, (s) => s));
    expect(without.map((f) => f.kind)).toEqual(['heading', 'item', 'item', 'button']);
    expect(compareStructure([source], [source], undefined, (s) => s)).toEqual([]);
  });

  it('reads ours through the normaliser and finds nothing when the words come back', () => {
    expect(compareStructure([source], [branded], undefined, back)).toEqual([]);
  });

  it('normalises ours only, never the source, and never an id or a count', () => {
    // the source is the pack's truth: a normaliser that would rewrite it must not be applied to it
    const findings = compareStructure([branded], [source], undefined, back);
    expect(findings.map((f) => f.kind)).toEqual(['heading', 'item', 'item', 'button']);
    // the normaliser below answers '1 images' to every string it is handed, so the source's
    // heading is that too and the only thing left to differ is the count, which is a number
    const counted = compareStructure(
      [section({ id: 's02-features', heading: '1 images', imageCount: 1 })],
      [section({ id: 's02-features', heading: 'Everything you need', imageCount: 2 })],
      undefined,
      () => '1 images',
    );
    expect(counted).toEqual([
      { kind: 'count', expected: '1 images', actual: '2 images', where: 's02-features' },
    ]);
  });
});
