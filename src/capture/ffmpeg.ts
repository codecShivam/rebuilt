import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** where playwright keeps its browsers and its ffmpeg, unless PLAYWRIGHT_BROWSERS_PATH says otherwise. */
export function playwrightCacheDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const custom = env['PLAYWRIGHT_BROWSERS_PATH'];
  if (custom && custom !== '0') return [custom];
  const home = os.homedir();
  return [
    path.join(home, 'Library', 'Caches', 'ms-playwright'),
    path.join(home, '.cache', 'ms-playwright'),
    path.join(env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local'), 'ms-playwright'),
  ];
}

const BUNDLED = ['ffmpeg-mac', 'ffmpeg-mac-arm64', 'ffmpeg-linux', 'ffmpeg-win64.exe'];

/** the build number in a `ffmpeg-<n>` cache entry, or null when it does not parse as one. */
function buildNumber(name: string): number | null {
  const m = /^ffmpeg-(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** newest build first; a non-numeric name (should not happen, but never trusted) sorts last. */
function byBuildNewestFirst(a: string, b: string): number {
  const na = buildNumber(a);
  const nb = buildNumber(b);
  if (na === null && nb === null) return a.localeCompare(b);
  if (na === null) return 1;
  if (nb === null) return -1;
  return nb - na;
}

async function executable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fsConstants.X_OK);
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

let cached: Promise<string> | null = null;

/**
 * the ffmpeg to run: one on PATH first, else the build playwright downloads next to its
 * browsers (`ffmpeg-<n>/ffmpeg-mac` under its cache, newest first). the bundled build is a
 * small one: it decodes the webm playwright records and writes png, but has no `fps` filter,
 * which is why motion.ts splits with `-r`. without options the answer is memoised.
 */
export function resolveFfmpeg(opts: { path?: string; cacheDirs?: string[] } = {}): Promise<string> {
  const plain = opts.path === undefined && opts.cacheDirs === undefined;
  if (plain && cached) return cached;
  const search = (async () => {
    const dirs = (opts.path ?? process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
      for (const name of ['ffmpeg', 'ffmpeg.exe']) {
        const file = path.join(dir, name);
        if (await executable(file)) return file;
      }
    }
    for (const cache of opts.cacheDirs ?? playwrightCacheDirs()) {
      let entries: string[];
      try {
        entries = await fs.readdir(cache);
      } catch {
        continue;
      }
      const builds = entries.filter((e) => e.startsWith('ffmpeg-')).sort(byBuildNewestFirst);
      for (const build of builds) {
        for (const name of BUNDLED) {
          const file = path.join(cache, build, name);
          if (await executable(file)) return file;
        }
      }
    }
    throw new Error(
      'ffmpeg not found: install it (brew install ffmpeg) or run `npx playwright install ffmpeg`. video is still recorded; frames need it.',
    );
  })();
  if (plain) cached = search;
  return search;
}
