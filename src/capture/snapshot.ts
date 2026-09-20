export interface SnapshotAssets {
  fileFor(url: string): string | null;
  readFile(file: string): Promise<Buffer>;
  contentTypeFor(url: string): string | null;
}

function splitFragment(url: string): [string, string] {
  const i = url.indexOf('#');
  return i < 0 ? [url, ''] : [url.slice(0, i), url.slice(i + 1)];
}

function resolve(raw: string, baseUrl: string): string | null {
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * the captured asset behind a url as a data url. the store is keyed by what was fetched, so
 * a fragment is dropped for the lookup; it is kept on the data url only for svg, where `#id`
 * addresses a symbol in a sprite. null when the store has nothing for the url.
 */
async function dataUrl(url: string, assets: SnapshotAssets): Promise<string | null> {
  const [bare, fragment] = splitFragment(url);
  const file = assets.fileFor(bare);
  if (!file) return null;
  const type = (assets.contentTypeFor(bare) ?? 'application/octet-stream').split(';')[0]!;
  const data = await assets.readFile(file);
  const keep = fragment && type.includes('svg') ? `#${fragment}` : '';
  return `data:${type};base64,${data.toString('base64')}${keep}`;
}

async function inlineCssUrls(
  css: string,
  baseUrl: string,
  assets: SnapshotAssets,
): Promise<string> {
  return replaceAsync(css, /url\((['"]?)([^'")]+)\1\)/g, async (whole, _quote, raw) => {
    if (!raw || raw.startsWith('data:')) return whole!;
    const abs = resolve(raw, baseUrl);
    const d = abs ? await dataUrl(abs, assets) : null;
    return d ? `url(${d})` : whole!;
  });
}

const IMPORT_RE = /@import\s+(?:url\(\s*(['"]?)([^'")]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/gi;

/**
 * replace each @import of a captured stylesheet with that sheet's body, itself inlined, under
 * `@media` when the import names a media list. a sheet already inlined into this snapshot (a
 * cycle, or two links to one sheet) becomes nothing; an uncaptured one is left as written.
 */
async function inlineImports(
  css: string,
  baseUrl: string,
  assets: SnapshotAssets,
  seen: Set<string>,
): Promise<string> {
  return replaceAsync(css, IMPORT_RE, async (whole, _q1, urlForm, _q2, stringForm, media) => {
    const raw = urlForm ?? stringForm ?? '';
    if (!raw || raw.startsWith('data:')) return whole!;
    const abs = resolve(raw, baseUrl);
    if (!abs) return whole!;
    if (seen.has(abs)) return '';
    const file = assets.fileFor(abs);
    if (!file) return whole!;
    seen.add(abs);
    const body = await inlineStylesheet(
      (await assets.readFile(file)).toString('utf8'),
      abs,
      assets,
      seen,
    );
    const list = (media ?? '').trim();
    return list ? `@media ${list} {\n${body}\n}` : body;
  });
}

/** a stylesheet body with its imports followed and its url() references inlined. */
async function inlineStylesheet(
  css: string,
  baseUrl: string,
  assets: SnapshotAssets,
  seen: Set<string>,
): Promise<string> {
  return inlineCssUrls(await inlineImports(css, baseUrl, assets, seen), baseUrl, assets);
}

/**
 * split a srcset into url/descriptor pairs per the html grammar, not on every comma: a url may
 * itself contain commas (a cloudinary-style path segment, a query string), so a comma only ends
 * a candidate when it terminates the url token (no whitespace before it) or when it is reached
 * while scanning for the next candidate after a descriptor.
 */
function parseSrcset(value: string): { url: string; descriptor: string }[] {
  const candidates: { url: string; descriptor: string }[] = [];
  const isSpace = (c: string) => /\s/.test(c);
  let i = 0;
  const n = value.length;
  while (i < n) {
    while (i < n && isSpace(value.charAt(i))) i++;
    while (i < n && value.charAt(i) === ',') i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !isSpace(value.charAt(i))) i++;
    let token = value.slice(start, i);
    let descriptor = '';
    if (token.endsWith(',')) {
      token = token.slice(0, -1);
    } else {
      while (i < n && isSpace(value.charAt(i))) i++;
      const descStart = i;
      while (i < n && value.charAt(i) !== ',') i++;
      descriptor = value.slice(descStart, i).trim();
      if (i < n && value.charAt(i) === ',') i++;
    }
    if (token) candidates.push({ url: token, descriptor });
  }
  return candidates;
}

/**
 * every candidate url of a srcset inlined; descriptors (`2x`, `480w`) stay. a srcset that
 * already holds a data url is left alone: its commas are not separators.
 */
async function inlineSrcset(
  value: string,
  baseUrl: string,
  assets: SnapshotAssets,
): Promise<string> {
  if (value.includes('data:')) return value;
  const out: string[] = [];
  for (const { url, descriptor } of parseSrcset(value)) {
    const abs = resolve(url, baseUrl);
    const d = abs ? await dataUrl(abs, assets) : null;
    out.push([d ?? url, descriptor].filter(Boolean).join(' '));
  }
  return out.join(', ');
}

/**
 * true when a url attribute's value is a javascript: url, the way a browser reads it: ascii
 * tab, newline and carriage return are stripped from anywhere in the value before the scheme
 * is read, so `jav\tascript:` and `java\nscript:` are javascript: urls too, not just a value
 * that literally starts with `javascript:`.
 */
function isJavascriptUrl(value: string): boolean {
  return /^\s*javascript:/i.test(value.replace(/[\t\n\r]/g, ''));
}

/**
 * remove on* handler attributes and neutralise javascript: urls inside tags. scripts are
 * already gone from dom.html; a snapshot is for opening, so its handlers go too. dom.html
 * keeps them: it records the page, the snapshot renders it.
 */
export function stripInlineScript(html: string): string {
  return html.replace(/<[a-zA-Z][^>]*>/g, (tag) =>
    tag
      .replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g, '')
      .replace(
        /(\s(?:href|src|action|formaction)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]*)/gi,
        (whole: string, prefix: string, rawValue: string) => {
          const inner = rawValue.replace(/^['"]|['"]$/g, '');
          return isJavascriptUrl(inner) ? `${prefix}"#"` : whole;
        },
      ),
  );
}

/** inline captured stylesheets, images, fonts and sprites into a single html document with no script in it. */
export async function buildSnapshot(
  dom: string,
  baseUrl: string,
  assets: SnapshotAssets,
): Promise<string> {
  let html = dom;
  const seen = new Set<string>();
  // stylesheets
  const links = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)];
  for (const m of links) {
    const href = /\shref=["']([^"']+)["']/i.exec(m[0])?.[1];
    if (!href) continue;
    const abs = resolve(href, baseUrl);
    const file = abs ? assets.fileFor(abs) : null;
    if (!abs || !file) continue;
    seen.add(abs);
    const css = await inlineStylesheet(
      (await assets.readFile(file)).toString('utf8'),
      abs,
      assets,
      seen,
    );
    // a replacer function, never a replacement string: css such as `content: '$'` holds
    // `$'`, `$&` and `` $` `` patterns that a string replacement would expand.
    html = html.replace(m[0], () => `<style>${css}</style>`);
  }
  // inline <style> blocks
  html = await replaceAsync(html, /<style[^>]*>([\s\S]*?)<\/style>/gi, async (whole, css) => {
    const inlined = await inlineStylesheet(css ?? '', baseUrl, assets, seen);
    return whole!.replace(css ?? '', () => inlined);
  });
  // images and srcset-free sources
  html = await replaceAsync(
    html,
    /(<(?:img|source|video|audio)\b[^>]*?\ssrc=["'])([^"']+)(["'])/gi,
    async (whole, pre, src, post) => {
      if (!src || src.startsWith('data:')) return whole!;
      const abs = resolve(src, baseUrl);
      const d = abs ? await dataUrl(abs, assets) : null;
      return d ? `${pre}${d}${post}` : whole!;
    },
  );
  // srcset on img and picture sources
  html = await replaceAsync(
    html,
    /(<(?:img|source)\b[^>]*?\ssrcset=["'])([^"']+)(["'])/gi,
    async (_whole, pre, srcset, post) =>
      `${pre}${await inlineSrcset(srcset ?? '', baseUrl, assets)}${post}`,
  );
  // svg sprites referenced by <use>
  html = await replaceAsync(
    html,
    /(<use\b[^>]*?\s(?:xlink:)?href=["'])([^"']+)(["'])/gi,
    async (whole, pre, href, post) => {
      if (!href || href.startsWith('#') || href.startsWith('data:')) return whole!;
      const abs = resolve(href, baseUrl);
      const d = abs ? await dataUrl(abs, assets) : null;
      return d ? `${pre}${d}${post}` : whole!;
    },
  );
  return stripInlineScript(html);
}

async function replaceAsync(
  input: string,
  re: RegExp,
  fn: (...m: (string | undefined)[]) => Promise<string>,
): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  for (const m of input.matchAll(re)) {
    parts.push(input.slice(last, m.index), await fn(...(m as unknown as (string | undefined)[])));
    last = m.index! + m[0].length;
  }
  parts.push(input.slice(last));
  return parts.join('');
}
