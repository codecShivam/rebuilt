import { describe, it, expect } from 'vitest';
import { stylesEqual } from '../../src/verify/styles';
import { indexByRef } from '../../src/verify/refs';
import type { ElementStyles } from '../../src/pack/schemas';

function element(over: Partial<ElementStyles> & { ref: string }): ElementStyles {
  return {
    ref: over.ref,
    dataRef: over.dataRef ?? null,
    tag: over.tag ?? 'div',
    bbox: over.bbox ?? { x: 0, y: 0, width: 10, height: 10 },
    styles: over.styles ?? {},
  };
}

describe('stylesEqual', () => {
  it('allows a length within one pixel and no more', () => {
    expect(stylesEqual('padding-left', '24px', '25px')).toBe(true);
    expect(stylesEqual('padding-left', '24px', '25.5px')).toBe(false);
  });

  it('compares only the first font family, unquoted', () => {
    expect(stylesEqual('font-family', '"Fixture", Arial', 'Fixture, sans-serif')).toBe(true);
    expect(stylesEqual('font-family', 'Fixture', 'Inter')).toBe(false);
  });

  it('holds a colour to the exact value', () => {
    expect(stylesEqual('color', 'rgb(1, 2, 3)', 'rgb(1, 2, 3)')).toBe(true);
    expect(stylesEqual('color', 'rgb(1, 2, 3)', 'rgb(1, 2, 4)')).toBe(false);
  });

  it('does not treat a percentage as a length it can round', () => {
    expect(stylesEqual('width', '50%', '50%')).toBe(true);
    expect(stylesEqual('width', '50%', '51%')).toBe(false);
  });

  it('never equates a normal line-height with a length', () => {
    expect(stylesEqual('line-height', 'normal', '24px')).toBe(false);
  });
});

describe('indexByRef', () => {
  it('lets an element with a data-ref win over one whose computed ref collides with it', () => {
    const tagged = element({ ref: 'rffffffff', dataRef: 'r0badcafe', tag: 'h1' });
    const plain = element({ ref: 'r0badcafe', tag: 'h2' });
    // either order: the author's own data-ref is the stronger claim on that key
    expect(indexByRef([plain, tagged]).get('r0badcafe')?.tag).toBe('h1');
    expect(indexByRef([tagged, plain]).get('r0badcafe')?.tag).toBe('h1');
  });

  it('keeps the first element for a computed ref when nothing claims it', () => {
    const first = element({ ref: 'r00000001', tag: 'h2' });
    const second = element({ ref: 'r00000001', tag: 'h3' });
    expect(indexByRef([first, second]).get('r00000001')?.tag).toBe('h2');
  });
});
