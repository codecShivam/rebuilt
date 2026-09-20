import type { StylesFile, VerifyResult } from '../pack/schemas';
import type { ViewportName } from '../pack/defaults';
import { indexByRef } from './refs';

type Finding = VerifyResult['styles'][number];

const LENGTH_PROPS =
  /^(width|height|min-|max-|margin-|padding-|gap|row-gap|column-gap|top|left|right|bottom|border-.*-width|border-.*-radius|font-size|line-height|letter-spacing|flex-basis)/;
const SKIP = new Set(['transform', 'background-image']); // compared elsewhere or too noisy
// the animations gate (animations.ts) owns these, with the keyframes they name
const OWNED_BY_ANIMATIONS = /^(animation|transition)-/;

function px(v: string): number | null {
  const m = /^(-?[\d.]+)px$/.exec(v.trim());
  return m ? parseFloat(m[1]!) : null;
}
function family(v: string): string {
  return (v.split(',')[0] ?? '').replace(/["']/g, '').trim().toLowerCase();
}

export function stylesEqual(prop: string, expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (prop === 'font-family') return family(expected) === family(actual);
  if (LENGTH_PROPS.test(prop)) {
    const a = px(expected);
    const b = px(actual);
    if (a !== null && b !== null) return Math.abs(a - b) <= 1;
  }
  if (prop === 'line-height' && (expected === 'normal' || actual === 'normal'))
    return expected === actual;
  return false;
}

export function compareStyles(
  source: StylesFile,
  ours: StylesFile,
  viewports: ViewportName[],
  restrictToPaths?: (path: string) => boolean,
): { findings: Finding[]; missing: string[] } {
  const findings: Finding[] = [];
  const missing: string[] = [];
  for (const vp of viewports) {
    const index = indexByRef(Object.values(ours[vp]));
    for (const [path, el] of Object.entries(source[vp])) {
      if (restrictToPaths && !restrictToPaths(path)) continue;
      const mine = index.get(el.ref);
      if (!mine) {
        if (!missing.includes(el.ref)) missing.push(el.ref);
        continue;
      }
      for (const [prop, expected] of Object.entries(el.styles)) {
        if (SKIP.has(prop) || OWNED_BY_ANIMATIONS.test(prop)) continue;
        const actual = mine.styles[prop] ?? '';
        if (!stylesEqual(prop, expected, actual))
          findings.push({ path, ref: el.ref, viewport: vp, property: prop, expected, actual });
      }
    }
  }
  return { findings, missing };
}
