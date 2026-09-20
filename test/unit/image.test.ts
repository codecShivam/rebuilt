import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import {
  cropPng,
  diffPngs,
  dirtyPoints,
  padRect,
  padToSize,
  applyMasks,
  regionsFromDiff,
  scalePng,
  unionRect,
} from '../../src/pack/image';

function solid(w: number, h: number, rgb: [number, number, number]): PNG {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return png;
}
function paint(
  png: PNG,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: [number, number, number],
) {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * png.width + xx) * 4;
      png.data[i] = rgb[0];
      png.data[i + 1] = rgb[1];
      png.data[i + 2] = rgb[2];
    }
}

describe('image', () => {
  it('scores identical images as zero', () => {
    const a = solid(100, 100, [255, 255, 255]);
    const b = solid(100, 100, [255, 255, 255]);
    const r = diffPngs(a, b);
    expect(r.mismatched).toBe(0);
    expect(r.score).toBe(0);
  });
  it('scores a painted block and finds its region', () => {
    const a = solid(160, 160, [255, 255, 255]);
    const b = solid(160, 160, [255, 255, 255]);
    paint(b, 32, 48, 32, 16, [255, 0, 0]);
    const r = diffPngs(a, b);
    expect(r.mismatched).toBe(32 * 16);
    expect(r.score).toBeCloseTo((32 * 16) / (160 * 160), 6);
    const regions = regionsFromDiff(r.diff, 16, 1);
    expect(regions).toEqual([{ x: 32, y: 48, width: 32, height: 16 }]);
  });
  it('ignores masked regions', () => {
    const a = solid(160, 160, [255, 255, 255]);
    const b = solid(160, 160, [255, 255, 255]);
    paint(b, 32, 48, 32, 16, [255, 0, 0]);
    const r = diffPngs(a, b, { masks: [{ x: 32, y: 48, width: 32, height: 16 }], scale: 1 });
    expect(r.mismatched).toBe(0);
  });
  it('crops by css rect and scale', () => {
    const a = solid(200, 200, [255, 255, 255]);
    paint(a, 20, 20, 40, 40, [0, 0, 255]);
    const c = cropPng(a, { x: 10, y: 10, width: 20, height: 20 }, 2);
    expect(c.width).toBe(40);
    expect(c.height).toBe(40);
    expect(c.data[0]).toBe(0);
    expect(c.data[2]).toBe(255);
  });
  it('pads to a common size and diffs different heights', () => {
    const a = solid(50, 50, [255, 255, 255]);
    const b = solid(50, 60, [255, 255, 255]);
    const r = diffPngs(a, b);
    expect(r.total).toBe(50 * 60);
    expect(r.mismatched).toBe(0);
    const p = padToSize(a, 50, 60);
    expect(p.height).toBe(60);
  });
  it('applies masks in place', () => {
    const a = solid(20, 20, [0, 0, 0]);
    applyMasks(a, [{ x: 0, y: 0, width: 10, height: 10 }], 1);
    expect(a.data[0]).toBe(255);
    expect(a.data[(19 * 20 + 19) * 4]).toBe(0);
  });
  it('refuses to crop a zero-area rect', () => {
    const a = solid(20, 20, [255, 255, 255]);
    expect(() => cropPng(a, { x: 0, y: 0, width: 0, height: 10 }, 1)).toThrow(/zero-area/);
    expect(() => cropPng(a, { x: 0, y: 0, width: 10, height: 0 }, 1)).toThrow(/zero-area/);
  });
  it('leaves its inputs untouched when it masks', () => {
    const a = solid(40, 40, [0, 0, 0]);
    const b = solid(40, 40, [0, 0, 0]);
    diffPngs(a, b, { masks: [{ x: 0, y: 0, width: 10, height: 10 }], scale: 1 });
    expect(a.data[0]).toBe(0);
    expect(b.data[0]).toBe(0);
  });
  it('samples dirty pixels per region in css px', () => {
    const a = solid(64, 64, [255, 255, 255]);
    const b = solid(64, 64, [255, 255, 255]);
    paint(b, 8, 8, 4, 4, [255, 0, 0]);
    paint(b, 40, 40, 2, 2, [255, 0, 0]);
    const r = diffPngs(a, b);
    const regions = regionsFromDiff(r.diff, 16, 2);
    expect(regions).toEqual([
      { x: 0, y: 0, width: 16, height: 16 },
      { x: 16, y: 16, width: 16, height: 16 },
    ]);
    const points = dirtyPoints([r.diff], regions, 2, 4);
    expect(points.filter((p) => p.region === 0)).toHaveLength(4);
    expect(points.filter((p) => p.region === 1)).toHaveLength(4);
    for (const p of points.filter((p) => p.region === 0)) {
      expect(p.x).toBeGreaterThanOrEqual(4);
      expect(p.x).toBeLessThan(6);
      expect(p.y).toBeGreaterThanOrEqual(4);
      expect(p.y).toBeLessThan(6);
    }
    // a region with no changed pixel samples nothing
    expect(dirtyPoints([r.diff], [{ x: 0, y: 48, width: 8, height: 8 }], 2, 4)).toEqual([]);
  });
  it('scales a png down to a width by averaging boxes', () => {
    const a = solid(200, 100, [255, 255, 255]);
    paint(a, 0, 0, 100, 100, [0, 0, 0]);
    const s = scalePng(a, 50);
    expect(s.width).toBe(50);
    expect(s.height).toBe(25);
    expect(s.data[0]).toBe(0);
    expect(s.data[49 * 4]).toBe(255);
    expect(scalePng(a, 400)).toBe(a);
  });
  it('unions and pads rects, clamped at the page edge', () => {
    expect(
      unionRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }),
    ).toEqual({ x: 0, y: 0, width: 15, height: 15 });
    expect(padRect({ x: 1, y: 10, width: 10, height: 10 }, 2)).toEqual({
      x: 0,
      y: 8,
      width: 13,
      height: 14,
    });
  });
});
