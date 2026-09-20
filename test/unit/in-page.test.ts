import { describe, it, expect } from 'vitest';
import { inPage } from '../../src/capture/browser/in-page';

describe('inPage', () => {
  it('wraps a function whose source calls __name so it runs where __name is undefined', () => {
    const fn = new Function(
      'x',
      'function inner(v) { return v * 2 } __name(inner, "inner"); return inner(x);',
    ) as (x: number) => number;
    expect(() => fn(21)).toThrow(ReferenceError);
    expect(inPage(fn)(21)).toBe(42);
  });

  it('still runs a plain function with no __name calls', () => {
    expect(inPage((x: number) => x + 1)(1)).toBe(2);
  });

  it('declares helpers in the page scope so a function can call one it did not define', () => {
    function twice(v: number): number {
      return v * 2;
    }
    const fn = new Function('x', 'return twice(x) + 1;') as (x: number) => number;
    expect(() => fn(20)).toThrow(ReferenceError);
    expect(inPage(fn, [twice])(20)).toBe(41);
  });
});
