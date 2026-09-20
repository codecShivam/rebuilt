import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { comparePixels } from '../../src/verify/pixel';
import { blankBorder, readPng, writePng } from '../../src/pack/image';

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

function row(png: PNG, y: number, rgb: [number, number, number]): void {
  for (let x = 0; x < png.width; x++) {
    const i = (y * png.width + x) * 4;
    png.data[i] = rgb[0];
    png.data[i + 1] = rgb[1];
    png.data[i + 2] = rgb[2];
  }
}

function pixel(png: PNG, x: number, y: number): [number, number, number] {
  const i = (y * png.width + x) * 4;
  return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
}

let root: string;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-pixel-'));
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('blankBorder', () => {
  it('paints nothing when the ring is zero wide', () => {
    // the no-op negative: no ring, no change
    const png = solid(6, 4, [10, 20, 30]);
    blankBorder(png, 0);
    expect(pixel(png, 0, 0)).toEqual([10, 20, 30]);
    expect(pixel(png, 5, 3)).toEqual([10, 20, 30]);
  });

  it('paints the outer ring white and leaves the inside alone', () => {
    const png = solid(6, 4, [10, 20, 30]);
    blankBorder(png, 1);
    for (const [x, y] of [
      [0, 0],
      [5, 0],
      [0, 3],
      [5, 3],
      [3, 0],
      [3, 3],
      [0, 2],
      [5, 2],
    ] as const) {
      expect(pixel(png, x, y), `${x},${y}`).toEqual([255, 255, 255]);
    }
    for (const [x, y] of [
      [1, 1],
      [4, 1],
      [1, 2],
      [4, 2],
    ] as const) {
      expect(pixel(png, x, y), `${x},${y}`).toEqual([10, 20, 30]);
    }
    // an image no wider than the ring is all border
    const thin = solid(2, 2, [10, 20, 30]);
    blankBorder(thin, 1);
    expect(pixel(thin, 0, 0)).toEqual([255, 255, 255]);
    expect(pixel(thin, 1, 1)).toEqual([255, 255, 255]);
  });
});

describe('comparePixels', () => {
  /** two 40x40 pages, identical but for one row, written where comparePixels reads them */
  async function pair(name: string, y: number): Promise<{ source: string; ours: string }> {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    const source = path.join(dir, 'source.png');
    const ours = path.join(dir, 'ours.png');
    const a = solid(40, 40, [255, 255, 255]);
    const b = solid(40, 40, [255, 255, 255]);
    row(b, y, [0, 0, 0]);
    await writePng(source, a);
    await writePng(ours, b);
    return { source, ours };
  }

  const box = { x: 0, y: 0, width: 40, height: 40 };

  it('scores a row inside a crop, wherever the crop came from', async () => {
    // the no-op negative for the ring: a row that is not on the crop's edge is the section's
    // own pixels and is scored the same with a box and without one
    const files = await pair('inside', 20);
    const outDir = path.join(root, 'inside', 'out');
    const cropped = await comparePixels({
      sourceFull: files.source,
      oursFull: files.ours,
      sourceBox: box,
      oursBox: box,
      masks: [],
      scale: 1,
      viewport: 'desktop',
      outDir,
      label: 's01',
    });
    // the row's own 38 pixels; its two ends sit in the ring's side bands, which are seam with
    // whatever is left and right of the crop
    expect(cropped.mismatched).toBe(38);
    // 40 x 40 less the one-pixel ring: 38 x 38 compared
    expect(cropped.total).toBe(38 * 38);
    expect(cropped.score).toBeCloseTo(38 / (38 * 38), 9);
    const whole = await comparePixels({
      sourceFull: files.source,
      oursFull: files.ours,
      sourceBox: null,
      oursBox: null,
      masks: [],
      scale: 1,
      viewport: 'desktop',
      outDir,
      label: 'page',
    });
    expect(whole.mismatched).toBe(40);
    expect(whole.total).toBe(40 * 40);
  });

  it('does not compare the seam ring of a crop, and does compare a whole page edge', async () => {
    // the last row of a section crop is the seam with the section below: `cropPng` rounds each
    // edge from a css box on its own, so a fractional one lands the neighbour's blended colour
    // there. measured on the second real run: 1170 pixels, the crop's whole width, one row,
    // 0.13831 % against a 0.001 gate, with nothing else to show for it
    const files = await pair('seam', 39);
    const outDir = path.join(root, 'seam', 'out');
    const cropped = await comparePixels({
      sourceFull: files.source,
      oursFull: files.ours,
      sourceBox: box,
      oursBox: box,
      masks: [],
      scale: 1,
      viewport: 'desktop',
      outDir,
      label: 's05',
    });
    expect(cropped.mismatched).toBe(0);
    expect(cropped.score).toBe(0);
    expect(cropped.total).toBe(38 * 38);
    // and the diff png shows no red hairline along the bottom
    const diff = await readPng(cropped.diffPng);
    expect(pixel(diff, 20, 39)).not.toEqual([255, 0, 0]);
    // a whole page has nothing bordering its edges, so the same row is compared there
    const whole = await comparePixels({
      sourceFull: files.source,
      oursFull: files.ours,
      sourceBox: null,
      oursBox: null,
      masks: [],
      scale: 1,
      viewport: 'desktop',
      outDir,
      label: 'page',
    });
    expect(whole.mismatched).toBe(40);
    expect(whole.score).toBeGreaterThan(0);
    expect(whole.total).toBe(40 * 40);
  });
});
