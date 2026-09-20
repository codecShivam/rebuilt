import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { AssetIndex } from '../pack/schemas';
import { fnv1a } from '../pack/ids';

type Kind = AssetIndex[number]['kind'];

function kindOf(url: string, contentType: string): Kind | null {
  const ct = contentType.toLowerCase();
  const ext = (new URL(url).pathname.split('.').pop() ?? '').toLowerCase();
  if (ct.includes('image/svg') || ext === 'svg') return 'svg';
  if (ct.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico'].includes(ext))
    return 'image';
  if (
    ct.startsWith('font/') ||
    ct.includes('font') ||
    ['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(ext)
  )
    return 'font';
  if (ct.includes('text/css') || ext === 'css') return 'stylesheet';
  return null;
}

function fileNameFor(url: string, kind: Kind): string {
  const u = new URL(url);
  const base = (u.pathname.split('/').pop() || 'asset')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
  return `${kind}-${fnv1a(url)}-${base}`;
}

/** the file extension for an inline font's media type */
const INLINE_EXT: Record<string, string> = {
  'font/woff2': 'woff2',
  'application/font-woff2': 'woff2',
  'font/woff': 'woff',
  'application/font-woff': 'woff',
  'application/x-font-woff': 'woff',
  'font/ttf': 'ttf',
  'application/x-font-ttf': 'ttf',
  'font/otf': 'otf',
  'application/x-font-opentype': 'otf',
};

export class AssetStore {
  entries: AssetIndex = [];
  failed: { url: string; reason: string }[] = [];
  private failedUrls = new Set<string>();
  private pending: Promise<void>[] = [];
  private seen = new Set<string>();
  constructor(readonly dir: string) {}

  fileFor(url: string): string | null {
    return this.entries.find((e) => e.url === url)?.file ?? null;
  }

  /** a failed asset is recorded once: the same image fails at every viewport of the unit. */
  fail(url: string, reason: string): void {
    if (this.failedUrls.has(url)) return;
    this.failedUrls.add(url);
    this.failed.push({ url, reason });
  }

  track(p: Promise<void>) {
    this.pending.push(p);
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.pending);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(
      path.join(this.dir, 'index.json'),
      JSON.stringify(this.entries, null, 2) + '\n',
    );
  }

  async save(url: string, contentType: string, body: Buffer): Promise<void> {
    const kind = kindOf(url, contentType);
    if (!kind || this.seen.has(url)) return;
    this.seen.add(url);
    const file = fileNameFor(url, kind);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, file), body);
    this.entries.push({ url, file, contentType, size: body.length, kind });
  }

  /**
   * a font face served as a data: url: decoded and kept like a fetched file, under the url,
   * so the same lookup finds it. the file is named for the face, not the url (the url is
   * the whole font). true when this call wrote one. a url that is not a readable data: font
   * (no media type, a malformed escape) is recorded as a failed asset and nothing else: a
   * face the capture could not decode is a gap in the mapping, never a failed unit.
   */
  async saveInline(url: string, hint: { family: string; weight: string }): Promise<boolean> {
    if (this.seen.has(url)) return false;
    const m = /^data:([^;,]+)(;base64)?,(.*)$/is.exec(url);
    if (!m) {
      this.fail(url, 'not a data: url with a media type');
      return false;
    }
    this.seen.add(url);
    const contentType = m[1]!.trim().toLowerCase();
    let body: Buffer;
    try {
      body = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'latin1');
    } catch (err) {
      this.fail(url, err instanceof Error ? err.message : String(err));
      return false;
    }
    const ext = INLINE_EXT[contentType] ?? 'bin';
    const family =
      hint.family
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'font';
    const file = `font-${fnv1a(url)}-inline-${family}-${hint.weight.replace(/\s+/g, '-')}.${ext}`;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, file), body);
    this.entries.push({ url, file, contentType, size: body.length, kind: 'font' });
    return true;
  }
}

/** save every image, svg, font and stylesheet response as it arrives. */
export function attachAssetCapture(page: Page, store: AssetStore): void {
  page.on('response', (response) => {
    const url = response.url();
    if (!/^https?:/.test(url)) return;
    const status = response.status();
    if (status >= 300 && status < 400) return;
    const contentType = response.headers()['content-type'] ?? '';
    if (!kindOf(url, contentType)) return;
    store.track(
      (async () => {
        if (status >= 400) {
          store.fail(url, `http ${status}`);
          return;
        }
        try {
          const body = await response.body();
          await store.save(url, contentType, body);
        } catch (err) {
          store.fail(url, err instanceof Error ? err.message : String(err));
        }
      })(),
    );
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (kindOf(url, '')) store.fail(url, request.failure()?.errorText ?? 'request failed');
  });
}
