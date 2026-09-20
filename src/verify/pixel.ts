import path from 'node:path';
import fs from 'node:fs/promises';
import { PNG } from 'pngjs';
import { PAGE_SHEET_PANEL_WIDTH, type ViewportName } from '../pack/defaults';
import type { Rect } from '../pack/schemas';
import {
  blankBorder,
  cropPng,
  diffPngs,
  padToSize,
  readPng,
  scalePng,
  writePng,
} from '../pack/image';

export interface PixelCompareInput {
  sourceFull: string;
  oursFull: string;
  sourceBox: Rect | null; // null = whole page
  oursBox: Rect | null;
  masks: Rect[];
  scale: number;
  viewport: ViewportName;
  outDir: string;
  label: string;
}

/** crop both sides, diff, write diff.png and a contact sheet (source | ours | diff). */
export async function comparePixels(input: PixelCompareInput) {
  const source = await readPng(input.sourceFull);
  const ours = await readPng(input.oursFull);
  const a = input.sourceBox ? cropPng(source, input.sourceBox, input.scale) : source;
  const b = input.oursBox ? cropPng(ours, input.oursBox, input.scale) : ours;
  // a crop's outer ring is the seam with the sections either side of it, not the section's own
  // pixels: each edge is rounded from a css box on its own, so a fractional one lands the
  // neighbour's blended colour in the first or last device row (measured on the second real
  // run: 1170 of 845910 pixels, exactly the crop's width, with no style, animation or
  // structure finding to name it, and a `heightDelta` of 0). it is painted out of both sides
  // and taken out of the total below, so the score is over compared pixels only. a whole-page
  // comparison keeps its edges: nothing borders them
  const ring = input.sourceBox ? 1 : 0;
  if (ring) {
    blankBorder(a, ring);
    blankBorder(b, ring);
  }
  // masks are page coordinates; shift them into the crop's frame
  const shift = input.sourceBox ? { x: input.sourceBox.x, y: input.sourceBox.y } : { x: 0, y: 0 };
  const masks = input.masks.map((m) => ({ ...m, x: m.x - shift.x, y: m.y - shift.y }));
  const r = diffPngs(a, b, { masks, scale: input.scale });
  const compared = ring
    ? Math.max(0, r.width - 2 * ring) * Math.max(0, r.height - 2 * ring)
    : r.total;
  const score = compared ? r.mismatched / compared : 0;
  await fs.mkdir(input.outDir, { recursive: true });
  const diffPng = path.join(input.outDir, `${input.label}.${input.viewport}.diff.png`);
  await writePng(diffPng, r.diff);
  const contactSheet = path.join(input.outDir, `${input.label}.${input.viewport}.sheet.png`);
  // a whole-page sheet of a 10,000 px page would be three panels of 2880 x 20,000 px: scaled
  // to a capped panel width it stays openable. a section sheet is small and stays full size
  const panels = [padToSize(a, r.width, r.height), padToSize(b, r.width, r.height), r.diff];
  await writePng(
    contactSheet,
    rowOf(input.sourceBox ? panels : panels.map((p) => scalePng(p, PAGE_SHEET_PANEL_WIDTH))),
  );
  return {
    score,
    mismatched: r.mismatched,
    total: compared,
    diffPng,
    contactSheet,
    heightDelta: (b.height - a.height) / input.scale,
  };
}

/** images side by side on a grey background, `gap` px apart. */
export function rowOf(images: PNG[], gap = 8): PNG {
  const width = images.reduce((w, i) => w + i.width, 0) + gap * (images.length - 1);
  const height = Math.max(...images.map((i) => i.height));
  const out = new PNG({ width, height });
  out.data.fill(200);
  let x = 0;
  for (const img of images) {
    for (let y = 0; y < img.height; y++)
      img.data.copy(out.data, (y * width + x) * 4, y * img.width * 4, (y + 1) * img.width * 4);
    x += img.width + gap;
  }
  return out;
}

/** images stacked top to bottom on a grey background, `gap` px apart. */
export function columnOf(images: PNG[], gap = 8): PNG {
  const width = Math.max(...images.map((i) => i.width));
  const height = images.reduce((h, i) => h + i.height, 0) + gap * (images.length - 1);
  const out = new PNG({ width, height });
  out.data.fill(200);
  let y0 = 0;
  for (const img of images) {
    for (let y = 0; y < img.height; y++)
      img.data.copy(out.data, (y0 + y) * width * 4, y * img.width * 4, (y + 1) * img.width * 4);
    y0 += img.height + gap;
  }
  return out;
}
