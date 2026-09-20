import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { resolveFfmpeg } from '../../src/capture/ffmpeg';
import { listFrames, splitVideo } from '../../src/capture/motion';
import { readPng } from '../../src/pack/image';

let browser: Browser;
let dir: string;
let video: string;

beforeAll(async () => {
  browser = await chromium.launch();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-motion-'));
  const context = await browser.newContext({
    viewport: { width: 400, height: 300 },
    recordVideo: { dir, size: { width: 400, height: 300 } },
  });
  const page = await context.newPage();
  await page.setContent(
    '<style>@keyframes k{to{background:#2563eb}} body{animation:k 1s forwards;height:100vh;margin:0}</style>',
  );
  await page.waitForTimeout(2500);
  const handle = page.video()!;
  await context.close();
  video = await handle.path();
}, 60_000);
afterAll(async () => {
  await browser.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('splitVideo', () => {
  it('writes the frames of a segment at the fps and honours the cap', async () => {
    const ffmpeg = await resolveFfmpeg();
    const out = path.join(dir, 'frames');
    const n = await splitVideo({
      ffmpeg,
      video,
      outDir: out,
      segment: 'load',
      start: 0,
      seconds: 1,
      fps: 30,
      maxFrames: 90,
    });
    expect(n).toBeGreaterThanOrEqual(25);
    expect(n).toBeLessThanOrEqual(31);
    const frames = await listFrames(out, 'load');
    expect(frames).toHaveLength(n);
    expect(frames[0]).toMatch(/load-0001\.png$/);
    const png = await readPng(frames[0]!);
    expect(png.width).toBe(400);
    expect(png.height).toBe(300);
    const capped = await splitVideo({
      ffmpeg,
      video,
      outDir: out,
      segment: 'cap',
      start: 0,
      seconds: 2,
      fps: 30,
      maxFrames: 10,
    });
    expect(capped).toBe(10);
    // the two segments live side by side
    expect(await listFrames(out, 'load')).toHaveLength(n);
  });

  it('yields no frames for a start past the end, without failing', async () => {
    const ffmpeg = await resolveFfmpeg();
    const n = await splitVideo({
      ffmpeg,
      video,
      outDir: path.join(dir, 'frames'),
      segment: 'late',
      start: 60,
      seconds: 1,
      fps: 30,
      maxFrames: 10,
    });
    expect(n).toBe(0);
  });

  it('lists nothing for a dir that does not exist', async () => {
    expect(await listFrames(path.join(dir, 'nope'), 'load')).toEqual([]);
  });
});
