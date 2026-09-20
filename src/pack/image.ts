import fs from 'node:fs/promises';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Rect } from './schemas';
import { PIXELMATCH_THRESHOLD } from './defaults';

export async function readPng(file: string): Promise<PNG> {
  return PNG.sync.read(await fs.readFile(file));
}

export async function writePng(file: string, png: PNG): Promise<void> {
  await fs.writeFile(file, PNG.sync.write(png));
}

export function clonePng(png: PNG): PNG {
  const out = new PNG({ width: png.width, height: png.height });
  png.data.copy(out.data);
  return out;
}

function fillWhite(png: PNG) {
  png.data.fill(255);
}

/** crop by a css-px rect at a device scale. out-of-bounds areas are white. */
export function cropPng(png: PNG, rect: Rect, scale: number): PNG {
  if (!(rect.width > 0 && rect.height > 0)) {
    throw new Error(
      `cannot crop a zero-area rect (${rect.width}x${rect.height} at ${rect.x},${rect.y})`,
    );
  }
  const x0 = Math.round(rect.x * scale);
  const y0 = Math.round(rect.y * scale);
  const w = Math.max(1, Math.round(rect.width * scale));
  const h = Math.max(1, Math.round(rect.height * scale));
  const out = new PNG({ width: w, height: h });
  fillWhite(out);
  for (let y = 0; y < h; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= png.height) continue;
    for (let x = 0; x < w; x++) {
      const sx = x0 + x;
      if (sx < 0 || sx >= png.width) continue;
      const si = (sy * png.width + sx) * 4;
      const di = (y * w + x) * 4;
      out.data[di] = png.data[si]!;
      out.data[di + 1] = png.data[si + 1]!;
      out.data[di + 2] = png.data[si + 2]!;
      out.data[di + 3] = png.data[si + 3]!;
    }
  }
  return out;
}

export function padToSize(png: PNG, width: number, height: number): PNG {
  if (png.width === width && png.height === height) return png;
  const out = new PNG({ width, height });
  fillWhite(out);
  for (let y = 0; y < Math.min(height, png.height); y++) {
    const rowLen = Math.min(width, png.width) * 4;
    png.data.copy(out.data, y * width * 4, y * png.width * 4, y * png.width * 4 + rowLen);
  }
  return out;
}

export function applyMasks(png: PNG, masks: Rect[], scale: number): void {
  for (const m of masks) {
    const x0 = Math.max(0, Math.floor(m.x * scale));
    const y0 = Math.max(0, Math.floor(m.y * scale));
    const x1 = Math.min(png.width, Math.ceil((m.x + m.width) * scale));
    const y1 = Math.min(png.height, Math.ceil((m.y + m.height) * scale));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const i = (y * png.width + x) * 4;
        png.data[i] = 255;
        png.data[i + 1] = 255;
        png.data[i + 2] = 255;
        png.data[i + 3] = 255;
      }
  }
}

/**
 * paint the outer `n`-pixel ring of an image white, in place. a section crop's edges are the
 * seam with the section above and below it: `cropPng` rounds each edge from a css box on its
 * own, so a fractional edge (measured: a mobile section at y 1593.375, scale 3) puts the
 * neighbour's blended colour in the crop's own last row. that row is not the section's, and a
 * comparison that scores it holds a rebuild to a pixel it does not own.
 */
export function blankBorder(png: PNG, n: number): void {
  const inside = (x: number, y: number) =>
    x >= n && y >= n && x < png.width - n && y < png.height - n;
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      if (inside(x, y)) {
        // skip the whole run between the two side bands rather than testing every pixel
        x = png.width - n - 1;
        continue;
      }
      const i = (y * png.width + x) * 4;
      png.data[i] = 255;
      png.data[i + 1] = 255;
      png.data[i + 2] = 255;
      png.data[i + 3] = 255;
    }
}

export interface DiffResult {
  mismatched: number;
  total: number;
  score: number;
  diff: PNG;
  width: number;
  height: number;
}

export function diffPngs(
  a: PNG,
  b: PNG,
  opts: { threshold?: number; masks?: Rect[]; scale?: number } = {},
): DiffResult {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  let pa = padToSize(a, width, height);
  let pb = padToSize(b, width, height);
  if (opts.masks?.length) {
    // padToSize hands back its input when nothing needs padding, and the masks paint white
    // over whatever they get: copy first, so a caller's png is the same after the diff
    if (pa === a) pa = clonePng(a);
    if (pb === b) pb = clonePng(b);
    applyMasks(pa, opts.masks, opts.scale ?? 1);
    applyMasks(pb, opts.masks, opts.scale ?? 1);
  }
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(pa.data, pb.data, diff.data, width, height, {
    threshold: opts.threshold ?? PIXELMATCH_THRESHOLD,
    includeAA: false,
  });
  const total = width * height;
  return { mismatched, total, score: total ? mismatched / total : 0, diff, width, height };
}

/** rectangles (css px) covering cells where the diff image marked mismatches. */
export function regionsFromDiff(diff: PNG, cell: number, scale: number): Rect[] {
  const cellPx = Math.max(1, Math.round(cell * scale));
  const cols = Math.ceil(diff.width / cellPx);
  const rows = Math.ceil(diff.height / cellPx);
  const dirty = new Uint8Array(cols * rows);
  for (let y = 0; y < diff.height; y++)
    for (let x = 0; x < diff.width; x++) {
      const i = (y * diff.width + x) * 4;
      // pixelmatch paints mismatches red (255, 0, 0) and anti-aliased skips yellow
      if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) {
        dirty[Math.floor(y / cellPx) * cols + Math.floor(x / cellPx)] = 1;
      }
    }
  // merge dirty cells into row runs, then merge vertically adjacent identical runs
  const runs: { row: number; c0: number; c1: number }[] = [];
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      if (!dirty[r * cols + c]) {
        c++;
        continue;
      }
      const c0 = c;
      while (c < cols && dirty[r * cols + c]) c++;
      runs.push({ row: r, c0, c1: c });
    }
  }
  const rects: { r0: number; r1: number; c0: number; c1: number }[] = [];
  for (const run of runs) {
    const prev = rects.find((x) => x.r1 === run.row && x.c0 === run.c0 && x.c1 === run.c1);
    if (prev) prev.r1 = run.row + 1;
    else rects.push({ r0: run.row, r1: run.row + 1, c0: run.c0, c1: run.c1 });
  }
  return rects.map((x) => ({
    x: (x.c0 * cellPx) / scale,
    y: (x.r0 * cellPx) / scale,
    width: ((x.c1 - x.c0) * cellPx) / scale,
    height: ((x.r1 - x.r0) * cellPx) / scale,
  }));
}

/** downscale to a width by box averaging; a png already at or under the width is returned as is. */
export function scalePng(png: PNG, maxWidth: number): PNG {
  if (png.width <= maxWidth) return png;
  const factor = png.width / maxWidth;
  const width = maxWidth;
  const height = Math.max(1, Math.round(png.height / factor));
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor(y * factor);
    const sy1 = Math.min(png.height, Math.max(sy0 + 1, Math.floor((y + 1) * factor)));
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor(x * factor);
      const sx1 = Math.min(png.width, Math.max(sx0 + 1, Math.floor((x + 1) * factor)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * png.width + sx) * 4;
          r += png.data[i]!;
          g += png.data[i + 1]!;
          b += png.data[i + 2]!;
          a += png.data[i + 3]!;
          n++;
        }
      }
      const o = (y * width + x) * 4;
      out.data[o] = Math.round(r / n);
      out.data[o + 1] = Math.round(g / n);
      out.data[o + 2] = Math.round(b / n);
      out.data[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** grow a rect by `pad` on every side; the top-left is clamped at 0 without shifting the far edge. */
export function padRect(r: Rect, pad: number): Rect {
  const x = Math.max(0, r.x - pad);
  const y = Math.max(0, r.y - pad);
  return { x, y, width: r.x + r.width + pad - x, height: r.y + r.height + pad - y };
}

export interface DirtyPoint {
  region: number;
  x: number;
  y: number;
}

/**
 * up to `perRegion` of the mismatched pixels inside each region, spread evenly over them in
 * scan order, as css px; each point names the region it came from. these are the pixels a
 * live element actually changed, which is where to ask the page what is painted there.
 */
export function dirtyPoints(
  diffs: PNG[],
  regions: Rect[],
  scale: number,
  perRegion: number,
): DirtyPoint[] {
  const out: DirtyPoint[] = [];
  regions.forEach((r, region) => {
    const hits: { x: number; y: number }[] = [];
    for (const diff of diffs) {
      const x0 = Math.max(0, Math.floor(r.x * scale));
      const y0 = Math.max(0, Math.floor(r.y * scale));
      const x1 = Math.min(diff.width, Math.ceil((r.x + r.width) * scale));
      const y1 = Math.min(diff.height, Math.ceil((r.y + r.height) * scale));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * diff.width + x) * 4;
          if (diff.data[i] === 255 && diff.data[i + 1] === 0 && diff.data[i + 2] === 0) {
            hits.push({ x, y });
          }
        }
      }
    }
    if (!hits.length) return;
    const step = Math.max(1, Math.floor(hits.length / perRegion));
    let taken = 0;
    for (let i = 0; i < hits.length && taken < perRegion; i += step) {
      const h = hits[i]!;
      out.push({ region, x: (h.x + 0.5) / scale, y: (h.y + 0.5) / scale });
      taken++;
    }
  });
  return out;
}
