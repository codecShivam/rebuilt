import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { playwrightCacheDirs, resolveFfmpeg } from '../../src/capture/ffmpeg';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'site-ffmpeg-'));
}
async function stub(file: string, mode = 0o755): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '#!/bin/sh\nexit 0\n', { mode });
}

describe('resolveFfmpeg', () => {
  it('prefers an executable ffmpeg on PATH and skips one that is not executable', async () => {
    const plain = await tmp();
    await stub(path.join(plain, 'ffmpeg'), 0o644);
    const bin = await tmp();
    await stub(path.join(bin, 'ffmpeg'));
    const cache = await tmp();
    await stub(path.join(cache, 'ffmpeg-1011', 'ffmpeg-mac'));
    const found = await resolveFfmpeg({
      path: [plain, bin].join(path.delimiter),
      cacheDirs: [cache],
    });
    expect(found).toBe(path.join(bin, 'ffmpeg'));
  });

  it("falls back to playwright's bundled build, newest first", async () => {
    const cache = await tmp();
    await stub(path.join(cache, 'ffmpeg-1009', 'ffmpeg-mac'));
    await stub(path.join(cache, 'ffmpeg-1011', 'ffmpeg-mac'));
    expect(await resolveFfmpeg({ path: await tmp(), cacheDirs: [cache] })).toBe(
      path.join(cache, 'ffmpeg-1011', 'ffmpeg-mac'),
    );
  });

  it('sorts bundled builds numerically, so ffmpeg-10000 beats ffmpeg-9999', async () => {
    const cache = await tmp();
    await stub(path.join(cache, 'ffmpeg-9999', 'ffmpeg-mac'));
    await stub(path.join(cache, 'ffmpeg-10000', 'ffmpeg-mac'));
    expect(await resolveFfmpeg({ path: await tmp(), cacheDirs: [cache] })).toBe(
      path.join(cache, 'ffmpeg-10000', 'ffmpeg-mac'),
    );
  });

  it('names both ways out when there is none', async () => {
    await expect(
      resolveFfmpeg({ path: await tmp(), cacheDirs: [await tmp(), '/nowhere/at/all'] }),
    ).rejects.toThrow(/brew install ffmpeg.*playwright install ffmpeg/);
  });

  it('honours PLAYWRIGHT_BROWSERS_PATH and knows the default caches', () => {
    expect(playwrightCacheDirs({ PLAYWRIGHT_BROWSERS_PATH: '/x' })).toEqual(['/x']);
    expect(playwrightCacheDirs({}).some((d) => d.endsWith('ms-playwright'))).toBe(true);
  });
});
