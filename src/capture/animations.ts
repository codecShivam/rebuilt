import type { CDPSession, Page } from 'playwright';
import { refFromPath } from '../pack/ids';
import type { KeyframeStop, ObservedAnimation } from '../pack/schemas';
import { inPage } from './browser/in-page';
import { stablePath as stablePathHelper } from './browser/targets';

export interface CssomFontFace {
  family: string;
  weight: string;
  style: string;
  urls: string[];
}

export interface CssomRead {
  keyframes: Record<string, KeyframeStop[]>;
  fontFaces: CssomFontFace[];
  /** hrefs of stylesheets whose rules the page may not read (cross-origin) */
  unreadable: string[];
}

/**
 * in-page, self-contained: one @keyframes rule as stops, in the spellings the cssom reports
 * (`0.5`, `0px`, longhands for a shorthand). shared by every in-page reader here through
 * inPage(fn, [keyframeStopsOf]), so a rule keys the same whichever of them found it.
 */
export function keyframeStopsOf(rule: CSSKeyframesRule): KeyframeStop[] {
  const stops: KeyframeStop[] = [];
  for (const k of Array.from(rule.cssRules)) {
    const frame = k as CSSKeyframeRule;
    const declarations: Record<string, string> = {};
    for (const prop of Array.from(frame.style)) {
      declarations[prop] = frame.style.getPropertyValue(prop);
    }
    // the cssom reports `from, 20%` as one keyText; one stop per offset, like a parsed body
    for (const key of frame.keyText.split(',')) {
      stops.push({ offset: key.trim(), declarations: { ...declarations } });
    }
  }
  return stops;
}

/**
 * in-page, self-contained apart from keyframeStopsOf: every @keyframes and @font-face the
 * page can read from its stylesheets, walking into @media, @supports and @import. a
 * cross-origin sheet throws on cssRules; its own href is listed instead, and the node side
 * parses the captured body (css.ts). font src urls are resolved against the sheet they were
 * declared in.
 */
export function readCssomInPage(): CssomRead {
  const out: CssomRead = { keyframes: {}, fontFaces: [], unreadable: [] };
  function walkSheet(sheet: CSSStyleSheet, base: string): void {
    try {
      walk(sheet.cssRules, base);
    } catch {
      out.unreadable.push(base);
    }
  }
  function walk(rules: CSSRuleList, base: string): void {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSKeyframesRule) {
        out.keyframes[rule.name] = keyframeStopsOf(rule);
      } else if (rule instanceof CSSImportRule) {
        // document.styleSheets lists top-level sheets only, so an imported sheet is reached
        // through its rule; guarded on its own, a cross-origin import is listed under its own
        // href and the rules after it in the importing sheet are still read
        const imported = rule.styleSheet;
        if (imported) walkSheet(imported, imported.href ?? base);
      } else if (rule instanceof CSSFontFaceRule) {
        const urls: string[] = [];
        for (const m of rule.style.getPropertyValue('src').matchAll(/url\((['"]?)([^'")]+)\1\)/g)) {
          try {
            urls.push(new URL(m[2]!, base).toString());
          } catch {
            /* an unparsable url is not a source */
          }
        }
        out.fontFaces.push({
          family: rule.style.getPropertyValue('font-family').replace(/^["']|["']$/g, ''),
          weight: rule.style.getPropertyValue('font-weight') || '400',
          style: rule.style.getPropertyValue('font-style') || 'normal',
          urls,
        });
      } else if ('cssRules' in rule) {
        walk((rule as CSSGroupingRule).cssRules, base);
      }
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    walkSheet(sheet, sheet.href ?? location.href);
  }
  return out;
}

/**
 * in-page, self-contained apart from keyframeStopsOf: the stops the cssom reports for
 * @keyframes text this process built. the engine that parses a constructed stylesheet is the
 * one that parsed the page's own sheets, so `.5` comes back `0.5`, `margin: 0` comes back as
 * four longhands, and a declaration the engine rejects does not come back at all.
 */
export function canonicaliseKeyframesInPage(opts: {
  rules: { name: string; text: string }[];
}): Record<string, KeyframeStop[]> {
  const out: Record<string, KeyframeStop[]> = {};
  // one constructed sheet per rule: a rule the engine cannot parse is dropped on its own, and
  // the rules after it are read as if it were never there
  for (const rule of opts.rules) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(rule.text);
    for (const r of Array.from(sheet.cssRules)) {
      if (r instanceof CSSKeyframesRule) out[r.name] = keyframeStopsOf(r);
    }
  }
  return out;
}

/** one @keyframes rule as a stylesheet can parse it back. */
export function keyframesText(name: string, stops: KeyframeStop[]): string {
  const body = stops
    .map(
      (s) =>
        `${s.offset} { ${Object.entries(s.declarations)
          .map(([prop, value]) => `${prop}: ${value};`)
          .join(' ')} }`,
    )
    .join(' ');
  return `@keyframes ${name} { ${body} }`;
}

/**
 * stylesheet-sourced @keyframes rules in cssom spellings: the rules go back into the page as
 * text, are parsed into a constructed stylesheet there and read back with the same walk the
 * cssom read uses. without this a rule the page could never read (a cross-origin sheet, a
 * sheet reached through @import) is recorded as written and compared as a string against a
 * rebuild's cssom, where `.5` is `0.5` and `margin: 0` is four longhands. a rule the engine
 * did not hand back keeps the stops the parser found.
 */
export async function canonicaliseKeyframes(
  page: Page,
  keyframes: Record<string, KeyframeStop[]>,
): Promise<Record<string, KeyframeStop[]>> {
  const names = Object.keys(keyframes);
  if (!names.length) return {};
  const rules = names.map((name) => ({ name, text: keyframesText(name, keyframes[name]!) }));
  const read = await page.evaluate(inPage(canonicaliseKeyframesInPage, [keyframeStopsOf]), {
    rules,
  });
  return Object.fromEntries(names.map((name) => [name, read[name] ?? keyframes[name]!]));
}

export interface AnimationObserver {
  /** name the phase later events belong to: `load` from the start, then `prepare`, then `settle` */
  mark(phase: string): void;
  /** stop listening and return everything seen, in start order */
  stop(): Promise<ObservedAnimation[]>;
}

/** the part of cdp's Animation.animationStarted payload this observer reads. */
interface StartedPayload {
  animation: {
    id: string;
    name: string;
    type: 'CSSTransition' | 'CSSAnimation' | 'WebAnimation';
    source?: {
      delay: number;
      iterations?: number;
      duration: number;
      easing: string;
      backendNodeId?: number;
      keyframesRule?: { keyframes: { offset: string; easing: string }[] };
    };
  };
}

/**
 * every animation chromium starts on the page from now on, through cdp Animation.enable:
 * css animations and transitions as well as waapi and js-driven ones, which the cssom never
 * shows. `iterations` is absent on the event for an endless animation and stored as null.
 * the element is resolved to its stable path when the event arrives, because an animated
 * node may be gone by the time the capture ends. call this before navigating: the events of
 * a page load start with the load.
 */
export async function observeAnimations(page: Page): Promise<AnimationObserver> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const started = Date.now();
  let phase = 'load';
  const seen: ObservedAnimation[] = [];
  const pending: Promise<void>[] = [];
  // the same shape inPage builds, evaluated by cdp on the node's own object. the element's
  // own data-ref comes back with its path: it is what the gate matches a rebuild by, and by
  // the time the observer stops the node may be gone
  const declaration = `function () { const __name = (target) => target; return { path: (${stablePathHelper.toString()})(this), dataRef: this.getAttribute ? this.getAttribute('data-ref') : null }; }`;
  async function nodeOf(
    backendNodeId: number | undefined,
  ): Promise<{ path: string; dataRef: string | null } | null> {
    if (backendNodeId === undefined) return null;
    try {
      const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
      if (!object.objectId) return null;
      const r = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: declaration,
        returnByValue: true,
      });
      await cdp.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
      const value = r.result.value as { path?: unknown; dataRef?: unknown } | undefined;
      if (typeof value?.path !== 'string') return null;
      return {
        path: value.path,
        dataRef: typeof value.dataRef === 'string' ? value.dataRef : null,
      };
    } catch {
      // the node is gone or the page navigated: the animation is still worth recording
      return null;
    }
  }
  const onStarted = (e: StartedPayload) => {
    const a = e.animation;
    const src = a.source;
    if (!src) return;
    const at = Date.now() - started;
    const p = phase;
    pending.push(
      (async () => {
        const node = await nodeOf(src.backendNodeId);
        const path = node?.path ?? null;
        seen.push({
          id: a.id,
          type: a.type,
          name: a.name,
          path,
          ref: path ? refFromPath(path) : null,
          dataRef: node?.dataRef ?? null,
          duration: src.duration,
          delay: src.delay,
          iterations: src.iterations === undefined ? null : src.iterations,
          easing: src.easing,
          keyframeEasings: (src.keyframesRule?.keyframes ?? []).map((k) => k.easing),
          phase: p,
          startedAt: at,
        });
      })(),
    );
  };
  cdp.on('Animation.animationStarted', onStarted);
  await cdp.send('Animation.enable');
  return {
    mark(next) {
      phase = next;
    },
    async stop() {
      cdp.off('Animation.animationStarted', onStarted);
      await Promise.allSettled(pending);
      await cdp.detach().catch(() => {});
      return seen.sort((x, y) => x.startedAt - y.startedAt || Number(x.id) - Number(y.id));
    },
  };
}
