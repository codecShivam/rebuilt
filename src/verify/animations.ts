import type { ViewportName } from '../pack/defaults';
import type {
  AnimationsFile,
  KeyframeStop,
  ObservedAnimation,
  VerifyResult,
} from '../pack/schemas';
import { indexByRef, refOf } from './refs';

type Finding = VerifyResult['animations'][number];

function hexToRgb(hex: string): string {
  const h = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const n = parseInt(h, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

/**
 * a keyframe value as both readers would spell it: lowercase, single spaces, no space inside
 * brackets, `, ` between list items, hex colours as rgb(). a unitless zero stays a zero: only
 * the cssom knows a property's unit.
 */
export function normaliseValue(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s*,\s*/g, ', ')
    .replace(/#([0-9a-f]{3}|[0-9a-f]{6})\b/g, (_m, h: string) => hexToRgb(h));
}

function offsetValue(offset: string): number {
  const o = offset.trim().toLowerCase();
  if (o === 'from') return 0;
  if (o === 'to') return 100;
  return parseFloat(o);
}

/** stops sorted by offset, one per offset (declarations merged, later wins), values normalised. */
export function normaliseStops(stops: KeyframeStop[]): KeyframeStop[] {
  const byOffset = new Map<string, Record<string, string>>();
  for (const stop of stops) {
    const key = `${offsetValue(stop.offset)}%`;
    const merged = byOffset.get(key) ?? {};
    for (const [prop, value] of Object.entries(stop.declarations)) {
      merged[prop.trim().toLowerCase()] = normaliseValue(value);
    }
    byOffset.set(key, merged);
  }
  return [...byOffset.entries()]
    .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
    .map(([offset, declarations]) => ({
      offset,
      declarations: Object.fromEntries(
        Object.entries(declarations).sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
    }));
}

/** `0% { opacity: 0; transform: none } 100% { opacity: 1 }`, for a finding's expected and actual. */
export function serialiseStops(stops: KeyframeStop[]): string {
  return stops
    .map(
      (s) =>
        `${s.offset} { ${Object.entries(s.declarations)
          .map(([p, v]) => `${p}: ${v}`)
          .join('; ')} }`,
    )
    .join(' ');
}

/** `500ms x2 ease-in +100ms`; `xinfinite` for an endless animation. */
export function describeObserved(a: ObservedAnimation): string {
  return `${a.duration}ms x${a.iterations === null ? 'infinite' : a.iterations} ${a.easing} +${a.delay}ms`;
}

function names(animationName: string | undefined): string[] {
  return (animationName ?? 'none')
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n && n !== 'none');
}

/**
 * the animations gate: for every element the source animates or transitions, the computed
 * longhands exact and the @keyframes it names (normalised, once per name and viewport); for
 * every js-driven (waapi) animation the source observed, one on ours with the same timing on
 * the same element. a missing animation is a finding. css animations and transitions seen
 * over cdp are not gated again here: the longhands and keyframes already cover them.
 */
export function compareAnimations(
  source: AnimationsFile,
  ours: AnimationsFile,
  viewports: ViewportName[],
  restrictToPaths?: (path: string) => boolean,
): Finding[] {
  const findings: Finding[] = [];
  for (const viewport of viewports) {
    const index = indexByRef(Object.values(ours.elements[viewport]));
    const keyframesSeen = new Set<string>();
    for (const [path, el] of Object.entries(source.elements[viewport])) {
      if (restrictToPaths && !restrictToPaths(path)) continue;
      const mine = index.get(el.ref);
      const finding = (property: string, expected: string, actual: string) =>
        findings.push({ path, ref: el.ref, viewport, property, expected, actual });
      if (el.animation) {
        const theirs = mine?.animation ?? null;
        if (!theirs) {
          finding('animation-name', el.animation['animation-name'] ?? '', 'none');
        } else {
          for (const [prop, expected] of Object.entries(el.animation)) {
            const actual = theirs[prop] ?? '';
            if (expected !== actual) finding(prop, expected, actual);
          }
        }
        for (const name of names(el.animation['animation-name'])) {
          if (keyframesSeen.has(name)) continue;
          keyframesSeen.add(name);
          const want = source.keyframes[name];
          if (!want) continue;
          const expected = serialiseStops(normaliseStops(want.stops));
          const got = ours.keyframes[name];
          const actual = got ? serialiseStops(normaliseStops(got.stops)) : '(missing)';
          if (expected !== actual) finding(`keyframes:${name}`, expected, actual);
        }
      }
      if (el.transition) {
        const theirs = mine?.transition ?? null;
        if (!theirs) {
          finding('transition-property', el.transition['transition-property'] ?? '', 'none');
        } else {
          for (const [prop, expected] of Object.entries(el.transition)) {
            const actual = theirs[prop] ?? '';
            if (expected !== actual) finding(prop, expected, actual);
          }
        }
      }
    }
    // js-driven animations: the cssom never lists them, so the observer is the only record.
    // an element carries several of them often enough that one of ours answers for one of the
    // source's and is then spent, which is what a map keyed by ref could not express
    const unmatched = ours.observed[viewport].filter((a) => a.type === 'WebAnimation');
    for (const a of source.observed[viewport]) {
      if (a.type !== 'WebAnimation' || !a.path || !a.ref) continue;
      if (restrictToPaths && !restrictToPaths(a.path)) continue;
      const at = unmatched.findIndex((b) => refOf(b) === a.ref);
      const match = at >= 0 ? unmatched.splice(at, 1)[0]! : null;
      const expected = describeObserved(a);
      const actual = match ? describeObserved(match) : '(missing)';
      if (expected !== actual) {
        findings.push({
          path: a.path,
          ref: a.ref,
          viewport,
          property: 'observed:WebAnimation',
          expected,
          actual,
        });
      }
    }
  }
  return findings;
}
