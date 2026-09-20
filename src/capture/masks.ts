import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import type { Viewport } from '../pack/defaults';
import { MASK_CELL, MASK_OWNER_MAX_RATIO, MASK_PAD, MASK_SAMPLE, SETTLE } from '../pack/defaults';
import { diffPngs, dirtyPoints, padRect, regionsFromDiff, unionRect } from '../pack/image';
import type { Rect } from '../pack/schemas';
import { inPage } from './browser/in-page';

export interface PointSample {
  region: number;
  x: number;
  y: number;
}

export interface ElementBox {
  region: number;
  path: string;
  box: Rect;
}

/**
 * in-page, self-contained: the element painted under each point (css px, page coordinates)
 * and its box, also in page coordinates. elementsFromPoint sees the viewport only, so a
 * point outside it scrolls the window there first; the window is returned to the top at the
 * end. html and body are never an answer: a change painted on them has no element to own it.
 * the stack is walked from the top down and the first element whose box fits inside the
 * region's own `maxArea` wins: a modal backdrop or a fixed transparent wrapper is painted
 * over every changed pixel and owns none of them.
 */
export function elementBoxesAtPointsInPage(opts: {
  points: PointSample[];
  /** per region, the largest box area in css px² that may own that region's change */
  maxArea: number[];
}): ElementBox[] {
  function stablePath(el: Element): string {
    const parts: string[] = [];
    let node: Element | null = el;
    while (node && node !== document.body) {
      const tag = node.tagName.toLowerCase();
      let n = 1;
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.tagName === node.tagName) n++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${tag}:nth-of-type(${n})`);
      node = node.parentElement;
    }
    return ['body', ...parts].join('>');
  }
  const out: ElementBox[] = [];
  const seen = new Set<string>();
  const sorted = [...opts.points].sort((a, b) => a.y - b.y);
  for (const p of sorted) {
    const top = window.scrollY;
    const height = window.innerHeight;
    if (p.y < top || p.y >= top + height) {
      window.scrollTo(0, Math.max(0, Math.floor(p.y - height / 2)));
    }
    const max = opts.maxArea[p.region] ?? Infinity;
    let hit: Element | null = null;
    let box: ElementBox['box'] | null = null;
    for (const el of document.elementsFromPoint(p.x - window.scrollX, p.y - window.scrollY)) {
      if (el === document.documentElement || el === document.body) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > max) continue;
      hit = el;
      box = {
        x: r.left + window.scrollX,
        y: r.top + window.scrollY,
        width: r.width,
        height: r.height,
      };
      break;
    }
    if (!hit || !box) continue;
    const path = stablePath(hit);
    const key = `${p.region}|${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ region: p.region, path, box });
  }
  window.scrollTo(0, 0);
  return out;
}

export interface DynamicShots {
  masks: Rect[];
  /** the last rest shot: the page's own full-page png */
  last: PNG;
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * the regions of a resting page that change on their own, as masks in css px. the page is
 * shot `shots` times `gap` apart; cells that differ between
 * consecutive shots are dirty. each dirty region becomes the padded box of the elements
 * painted under its changed pixels (a live counter's own <strong>, not the line it sits in),
 * which is what milestone 2's one-cell padding stood in for. an element more than
 * MASK_OWNER_MAX_RATIO times the region's area is not its owner (a modal backdrop catches
 * every point on the page), and a region whose changed pixels sit on nothing that qualifies
 * keeps the padded cell.
 */
export async function dynamicMasks(
  page: Page,
  viewport: Viewport,
  /** the pack's own shot count and gap; SETTLE's when the caller has no manifest to read */
  opts: { shots?: number; gap?: number } = {},
): Promise<DynamicShots> {
  const count = opts.shots ?? SETTLE.dynamicShots;
  const gap = opts.gap ?? SETTLE.dynamicGap;
  const shots: PNG[] = [];
  for (let i = 0; i < count; i++) {
    if (i > 0) await page.waitForTimeout(gap);
    shots.push(PNG.sync.read(await page.screenshot({ fullPage: true, type: 'png' })));
  }
  const last = shots[shots.length - 1]!;
  const diffs = shots.slice(1).map((shot, i) => diffPngs(shots[i]!, shot).diff);
  const regions: Rect[] = [];
  for (const diff of diffs) {
    for (const r of regionsFromDiff(diff, MASK_CELL, viewport.scale)) {
      if (!regions.some((q) => sameRect(q, r))) regions.push(r);
    }
  }
  if (!regions.length) return { masks: [], last };
  const points = dirtyPoints(diffs, regions, viewport.scale, MASK_SAMPLE);
  const maxArea = regions.map((r) => r.width * r.height * MASK_OWNER_MAX_RATIO);
  const boxes = await page.evaluate(inPage(elementBoxesAtPointsInPage), { points, maxArea });
  const masks: Rect[] = [];
  regions.forEach((cell, i) => {
    const own = boxes.filter((b) => b.region === i && b.box.width > 0 && b.box.height > 0);
    const rect = own.length
      ? padRect(own.map((b) => b.box).reduce(unionRect), MASK_PAD)
      : padRect(cell, MASK_CELL);
    if (!masks.some((m) => sameRect(m, rect))) masks.push(rect);
  });
  return { masks, last };
}
