import * as csstree from 'css-tree';
import type { CssNode } from 'css-tree';

export interface KeyframeStop {
  offset: string;
  declarations: Record<string, string>;
}
export interface ParsedFontFace {
  family: string;
  weight: string;
  style: string;
  /** absolute, resolved against the stylesheet's url, in source order */
  urls: string[];
}
export interface ParsedImport {
  url: string;
  media: string;
}
export interface ParsedStylesheet {
  keyframes: Record<string, KeyframeStop[]>;
  fontFaces: ParsedFontFace[];
  imports: ParsedImport[];
  /** onParseError calls across every top-level rule; a caller can warn past some threshold. */
  parseErrors: number;
}

/** strip one pair of matching quotes. */
export function unquote(s: string): string {
  const t = s.trim();
  return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t;
}

/** keyframe selectors as the cssom reports them: `from` is `0%`, `to` is `100%`. */
export function normaliseOffset(selector: string): string {
  const s = selector.trim().toLowerCase();
  if (s === 'from') return '0%';
  if (s === 'to') return '100%';
  return s;
}

/** an already-absolute url is kept as-is; only a relative one is resolved against baseUrl.
 * a bare `new URL(url, baseUrl)` throws whenever baseUrl itself fails to parse, even if url
 * was already absolute and never needed it - so absolute is tried first, on its own. */
function absolute(url: string, baseUrl: string): string | null {
  try {
    return new URL(url).toString();
  } catch {
    // not already absolute; fall through to resolving against the stylesheet's own url
  }
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return null;
  }
}

function urlsIn(node: CssNode): string[] {
  const out: string[] = [];
  csstree.walk(node, {
    visit: 'Url',
    enter(u) {
      out.push(u.value);
    },
  });
  return out;
}

/**
 * splits a stylesheet into its top-level statements (rules and at-rules) so each can be
 * parsed on its own. tracks brace depth (a statement's block), paren depth (so a `;` inside
 * `url(...)` is never mistaken for the end of a statement), quoted strings and `/* *\/`
 * comments. this is what keeps one malformed rule - an unclosed paren that would otherwise
 * make css-tree consume the rest of the sheet looking for a matching token - from swallowing
 * every rule after it: each chunk here gets its own, independent css-tree.parse call.
 */
function splitTopLevel(css: string): string[] {
  const rules: string[] = [];
  const n = css.length;
  let start = 0;
  let braceDepth = 0;
  let parenDepth = 0;
  let quote: string | null = null;
  let i = 0;
  while (i < n) {
    const c = css[i]!;
    if (quote) {
      if (c === '\\') i += 2;
      else {
        if (c === quote) quote = null;
        i++;
      }
      continue;
    }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      i++;
      continue;
    }
    if (c === '(') {
      parenDepth++;
      i++;
      continue;
    }
    if (c === ')') {
      if (parenDepth > 0) parenDepth--;
      i++;
      continue;
    }
    if (c === '{') {
      braceDepth++;
      i++;
      continue;
    }
    if (c === '}') {
      if (braceDepth > 0) braceDepth--;
      if (braceDepth === 0) {
        rules.push(css.slice(start, i + 1));
        start = i + 1;
        // an unclosed paren is a per-rule malformation; it must not poison the next rule.
        parenDepth = 0;
      }
      i++;
      continue;
    }
    if (c === ';' && braceDepth === 0 && parenDepth === 0) {
      rules.push(css.slice(start, i + 1));
      start = i + 1;
      i++;
      continue;
    }
    i++;
  }
  const tail = css.slice(start).trim();
  if (tail) rules.push(tail);
  return rules.map((r) => r.trim()).filter((r) => r.length > 0);
}

/** parses one top-level rule and folds whatever it finds into `out`; returns its error count. */
function parseRule(css: string, baseUrl: string, out: ParsedStylesheet): number {
  let errors = 0;
  const ast = csstree.parse(css, {
    onParseError() {
      errors++;
    },
  });
  csstree.walk(ast, {
    visit: 'Atrule',
    enter(node) {
      const name = node.name.toLowerCase().replace(/^-(webkit|moz|o|ms)-/, '');
      if (name === 'import' && node.prelude && node.prelude.type === 'AtrulePrelude') {
        const pre: { target: string | null; media: string[] } = { target: null, media: [] };
        node.prelude.children.forEach((n) => {
          if (n.type === 'Url' || n.type === 'String') pre.target = n.value;
          else pre.media.push(csstree.generate(n));
        });
        const abs = pre.target ? absolute(pre.target, baseUrl) : null;
        if (abs) out.imports.push({ url: abs, media: pre.media.join(' ').trim() });
        return;
      }
      if (name === 'font-face' && node.block) {
        const face: ParsedFontFace = { family: '', weight: '400', style: 'normal', urls: [] };
        node.block.children.forEach((d) => {
          if (d.type !== 'Declaration') return;
          const prop = d.property.toLowerCase();
          if (prop === 'src') {
            for (const u of urlsIn(d.value)) {
              const abs = absolute(u, baseUrl);
              if (abs) face.urls.push(abs);
            }
          } else if (prop === 'font-family') face.family = unquote(csstree.generate(d.value));
          else if (prop === 'font-weight') face.weight = csstree.generate(d.value).trim();
          else if (prop === 'font-style') face.style = csstree.generate(d.value).trim();
        });
        if (face.family) out.fontFaces.push(face);
        return;
      }
      if (name === 'keyframes' && node.block && node.prelude) {
        const kfName = csstree.generate(node.prelude).trim();
        const stops: KeyframeStop[] = [];
        node.block.children.forEach((rule) => {
          if (rule.type !== 'Rule' || rule.prelude.type !== 'SelectorList') return;
          const declarations: Record<string, string> = {};
          rule.block.children.forEach((d) => {
            if (d.type === 'Declaration') {
              declarations[d.property.toLowerCase()] = csstree.generate(d.value).trim();
            }
          });
          // `from, 20% { ... }` is one rule for two offsets; the cssom lists it once per offset
          rule.prelude.children.forEach((sel) => {
            stops.push({
              offset: normaliseOffset(csstree.generate(sel)),
              declarations: { ...declarations },
            });
          });
        });
        out.keyframes[kfName] = stops;
      }
    },
  });
  return errors;
}

/**
 * what a stylesheet declares that the page cannot always read back: a cross-origin sheet
 * throws on cssRules, so its @keyframes and @font-face come from the captured body here.
 * urls are resolved against the sheet's own url. recovery from a broken rule is per top-level
 * rule, not per sheet: the sheet is first split into its top-level statements (splitTopLevel),
 * each parsed on its own, so one malformed rule cannot make css-tree consume everything after
 * it and lose every @font-face, @keyframes or @import that follows. values are kept as
 * written; the cssom would normalise them, and the verify gate knows that.
 */
export function parseStylesheet(css: string, baseUrl: string): ParsedStylesheet {
  const out: ParsedStylesheet = { keyframes: {}, fontFaces: [], imports: [], parseErrors: 0 };
  for (const rule of splitTopLevel(css)) {
    out.parseErrors += parseRule(rule, baseUrl, out);
  }
  return out;
}
