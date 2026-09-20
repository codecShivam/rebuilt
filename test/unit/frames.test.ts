import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { compareFrames, stripIndices } from '../../src/verify/frames';
import { summarise } from '../../src/verify/report';
import { readPng, writePng } from '../../src/pack/image';
import { MOTION } from '../../src/pack/defaults';
import type { MotionInfo, VerifyResult } from '../../src/pack/schemas';

function solid(w: number, h: number, rgb: [number, number, number]): PNG {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) {
    png.data[i * 4] = rgb[0];
    png.data[i * 4 + 1] = rgb[1];
    png.data[i * 4 + 2] = rgb[2];
    png.data[i * 4 + 3] = 255;
  }
  return png;
}
function paint(
  png: PNG,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: [number, number, number],
) {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * png.width + xx) * 4;
      png.data[i] = rgb[0];
      png.data[i + 1] = rgb[1];
      png.data[i + 2] = rgb[2];
    }
}

const motion = (frames: number): MotionInfo => ({
  video: null,
  fps: 30,
  settleAt: 1200,
  segments: [{ name: 'load', start: 0, seconds: 1.2, frames }],
  framesKept: true,
  note: null,
});

/** the stand-in ffmpeg the re-split tests hand to compareFrames */
const FAKE_FFMPEG_DIR = path.resolve('test/helpers/fake-ffmpeg');
const FAKE_FFMPEG = path.join(FAKE_FFMPEG_DIR, 'ffmpeg');

let root: string;
let sourceDir: string;
let oursDir: string;
let oldPath: string | undefined;

async function writeFrames(dir: string, frames: PNG[]): Promise<void> {
  const framesDir = path.join(dir, 'desktop', 'frames');
  await fs.mkdir(framesDir, { recursive: true });
  for (const [i, png] of frames.entries()) {
    await writePng(path.join(framesDir, `load-${String(i + 1).padStart(4, '0')}.png`), png);
  }
}

beforeAll(async () => {
  // the fake's launcher runs `node` and splitVideo spawns it with this process's env: this
  // node first, then the fake's own dir so `ffmpeg` also resolves by name. the child only.
  oldPath = process.env['PATH'];
  process.env['PATH'] = [path.dirname(process.execPath), FAKE_FFMPEG_DIR, oldPath ?? ''].join(
    path.delimiter,
  );
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-frames-'));
  sourceDir = path.join(root, 'source');
  oursDir = path.join(root, 'ours');
  await writeFrames(sourceDir, [
    solid(400, 300, [255, 255, 255]),
    solid(400, 300, [255, 255, 255]),
    solid(400, 300, [255, 255, 255]),
  ]);
  const changed = solid(400, 300, [255, 255, 255]);
  paint(changed, 100, 100, 40, 40, [255, 0, 0]);
  await writeFrames(oursDir, [
    solid(400, 300, [255, 255, 255]),
    changed,
    solid(400, 300, [255, 255, 255]),
  ]);
});
afterAll(async () => {
  if (oldPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = oldPath;
  await fs.rm(root, { recursive: true, force: true });
});

describe('compareFrames', () => {
  it('reports zero for a side against itself and writes a strip', async () => {
    const outDir = path.join(root, 'out-self');
    const { reports, artefacts } = await compareFrames({
      sourceDir,
      oursDir: sourceDir,
      sourceMotion: motion(3),
      oursMotion: motion(3),
      viewport: 'desktop',
      masks: [],
      outDir,
      label: 'page',
      scratch: path.join(root, 'scratch-self'),
    });
    expect(reports).toEqual([
      {
        viewport: 'desktop',
        segment: 'load',
        compared: 3,
        meanScore: 0,
        maxScore: 0,
        worstFrame: 1,
        strip: path.join(outDir, 'page.desktop.load.strip.png'),
        note: null,
      },
    ]);
    expect(artefacts).toEqual([reports[0]!.strip]);
    const strip = await readPng(reports[0]!.strip!);
    // three rows of three panels, each panel scaled to the strip width
    expect(strip.width).toBe(MOTION.stripPanelWidth * 3 + 16);
    expect(strip.height).toBe(240 * 3 + 16);
  });

  it('names the worst frame and honours the masks', async () => {
    const r = await compareFrames({
      sourceDir,
      oursDir,
      sourceMotion: motion(3),
      oursMotion: motion(3),
      viewport: 'desktop',
      masks: [],
      outDir: path.join(root, 'out-diff'),
      label: 'page',
      scratch: path.join(root, 'scratch-diff'),
    });
    expect(r.reports[0]!.compared).toBe(3);
    expect(r.reports[0]!.worstFrame).toBe(2);
    expect(r.reports[0]!.maxScore).toBeCloseTo((40 * 40) / (400 * 300), 6);
    expect(r.reports[0]!.meanScore).toBeCloseTo((40 * 40) / (400 * 300) / 3, 6);
    const masked = await compareFrames({
      sourceDir,
      oursDir,
      sourceMotion: motion(3),
      oursMotion: motion(3),
      viewport: 'desktop',
      masks: [{ x: 100, y: 100, width: 40, height: 40 }],
      outDir: path.join(root, 'out-masked'),
      label: 'page',
      scratch: path.join(root, 'scratch-masked'),
    });
    expect(masked.reports[0]!.maxScore).toBe(0);
  });

  it('reports nothing compared when a side has no frames and no video', async () => {
    const r = await compareFrames({
      sourceDir,
      oursDir: path.join(root, 'nowhere'),
      sourceMotion: motion(3),
      oursMotion: motion(0),
      viewport: 'desktop',
      masks: [],
      outDir: path.join(root, 'out-none'),
      label: 'page',
      scratch: path.join(root, 'scratch-none'),
    });
    expect(r.reports).toEqual([
      {
        viewport: 'desktop',
        segment: 'load',
        compared: 0,
        meanScore: 0,
        maxScore: 0,
        worstFrame: 0,
        strip: null,
        note: 'no frames on ours: no video, no ffmpeg, or a load that settled before the first frame',
      },
    ]);
    expect(r.artefacts).toEqual([]);
  });

  /** a side whose frames were not kept, so only its video is left to split again */
  async function resplitDir(name: string): Promise<string> {
    const dir = path.join(root, name);
    for (const side of ['source', 'ours']) {
      await fs.mkdir(path.join(dir, side, 'desktop'), { recursive: true });
      await fs.writeFile(path.join(dir, side, 'desktop', 'video.webm'), 'not really a video');
    }
    return dir;
  }
  // a segment that neither starts at zero nor runs the full cap: the split has to be told
  // this segment's own start and length
  const unkept = (): MotionInfo => ({
    ...motion(5),
    video: 'video.webm',
    framesKept: false,
    segments: [{ name: 'load', start: 0.5, seconds: 1.2, frames: 5 }],
  });

  it('splits the video again when the frames were not kept, through the resolver it is given', async () => {
    const dir = await resplitDir('resplit');
    const r = await compareFrames({
      sourceDir: path.join(dir, 'source'),
      oursDir: path.join(dir, 'ours'),
      sourceMotion: unkept(),
      oursMotion: unkept(),
      viewport: 'desktop',
      masks: [],
      outDir: path.join(dir, 'out'),
      label: 'page',
      scratch: path.join(dir, 'scratch'),
      resolveFfmpeg: async () => FAKE_FFMPEG,
    });
    // the fake writes what the split asked for, which is the segment's frame cap
    expect(r.reports[0]).toMatchObject({
      compared: MOTION.maxFramesPerSegment,
      meanScore: 0,
      note: null,
    });
    const split = path.join(dir, 'scratch', 'source', 'desktop');
    expect((await fs.readdir(split)).filter((n) => n.endsWith('.png'))).toHaveLength(
      MOTION.maxFramesPerSegment,
    );
    const argv = JSON.parse(await fs.readFile(path.join(split, 'argv.json'), 'utf8')) as string[];
    expect(argv[argv.indexOf('-ss') + 1]).toBe('0.500');
    expect(argv[argv.indexOf('-t') + 1]).toBe('1.2');
    expect(argv[argv.indexOf('-frames:v') + 1]).toBe(String(MOTION.maxFramesPerSegment));
  });

  it('says nothing was compared on either side when the re-split fails', async () => {
    const dir = await resplitDir('resplit-fails');
    process.env['SITE_FAKE_FFMPEG_EXIT'] = '1';
    try {
      const r = await compareFrames({
        sourceDir: path.join(dir, 'source'),
        oursDir: path.join(dir, 'ours'),
        sourceMotion: unkept(),
        oursMotion: unkept(),
        viewport: 'desktop',
        masks: [],
        outDir: path.join(dir, 'out'),
        label: 'page',
        scratch: path.join(dir, 'scratch'),
        resolveFfmpeg: async () => FAKE_FFMPEG,
      });
      // ffmpeg exited non-zero on both sides: a lost report, not a thrown verify
      expect(r.reports[0]).toMatchObject({
        compared: 0,
        strip: null,
        note: 'no frames on either side: no video, no ffmpeg, or a load that settled before the first frame',
      });
      expect(r.artefacts).toEqual([]);
    } finally {
      delete process.env['SITE_FAKE_FFMPEG_EXIT'];
    }
  });

  it('says why nothing was compared', async () => {
    const none = await compareFrames({
      sourceDir: path.join(root, 'nowhere-src'),
      oursDir: sourceDir,
      sourceMotion: motion(0),
      oursMotion: motion(3),
      viewport: 'desktop',
      masks: [],
      outDir: path.join(root, 'out-note'),
      label: 'page',
      scratch: path.join(root, 'scratch-note'),
    });
    expect(none.reports[0]!.note).toBe(
      'no source frames: no video, no ffmpeg, or a load that settled before the first frame',
    );
    const ours = await compareFrames({
      sourceDir,
      oursDir: path.join(root, 'nowhere-ours'),
      sourceMotion: motion(3),
      oursMotion: motion(0),
      viewport: 'desktop',
      masks: [],
      outDir: path.join(root, 'out-note-2'),
      label: 'page',
      scratch: path.join(root, 'scratch-note-2'),
    });
    expect(ours.reports[0]!.note).toBe(
      'no frames on ours: no video, no ffmpeg, or a load that settled before the first frame',
    );
  });

  it('spreads strip indices evenly with both ends in', () => {
    expect(stripIndices(10, 6)).toEqual([0, 2, 4, 5, 7, 9]);
    expect(stripIndices(3, 6)).toEqual([0, 1, 2]);
    expect(stripIndices(1, 6)).toEqual([0]);
  });

  it('carries the note into the summary, so 0 compared says why', () => {
    const result = (note: string | null): VerifyResult => ({
      unitId: 'page:index',
      target: 'http://127.0.0.1:3000',
      verdict: 'pass',
      gate: 0.001,
      pixel: { mobile: null, desktop: null },
      heightDelta: { mobile: null, desktop: null },
      styles: [],
      structure: [],
      animations: [],
      frames: [
        {
          viewport: 'desktop',
          segment: 'load',
          compared: 0,
          meanScore: 0,
          maxScore: 0,
          worstFrame: 0,
          strip: null,
          note,
        },
      ],
      missing: [],
      artefacts: [],
    });
    const framesLine = (r: VerifyResult) =>
      summarise(r)
        .split('\n')
        .find((l) => l.includes('frames desktop'))!;
    // the no-op negative: a segment that was compared has no note, and nothing is added
    expect(framesLine(result(null))).toBe(
      '  frames desktop load: 0 compared, mean 0.00%, max 0.00% at frame 0',
    );
    // the producer has written this note since milestone 3 and nothing ever printed it: a
    // reader saw `0 compared` and could not tell a missing video from a clean comparison
    const note = 'no source frames: no video, no ffmpeg, or a load that settled before it';
    expect(framesLine(result(note))).toBe(
      `  frames desktop load: 0 compared, mean 0.00%, max 0.00% at frame 0 (${note})`,
    );
  });
});
