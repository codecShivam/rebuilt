import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

export interface SplitOptions {
  ffmpeg: string;
  video: string;
  outDir: string;
  /** frames are named `<segment>-NNNN.png` from 0001 */
  segment: string;
  /** seconds into the video */
  start: number;
  seconds: number;
  fps: number;
  maxFrames: number;
}

/**
 * one stretch of a video as png frames under outDir. `-r` sets the output rate by duplicating
 * or dropping frames (the bundled ffmpeg has no fps filter); `-ss` before `-i` seeks the
 * input, and a start past the end writes nothing and is not an error. returns how many
 * frames were written.
 */
export async function splitVideo(opts: SplitOptions): Promise<number> {
  await fs.mkdir(opts.outDir, { recursive: true });
  const pattern = path.join(opts.outDir, `${opts.segment}-%04d.png`);
  await execa(opts.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-ss',
    opts.start.toFixed(3),
    '-i',
    opts.video,
    '-t',
    String(opts.seconds),
    '-r',
    String(opts.fps),
    '-frames:v',
    String(opts.maxFrames),
    pattern,
  ]);
  return (await listFrames(opts.outDir, opts.segment)).length;
}

/** the frame index in a `<segment>-NNNN.png` name, or null when it does not parse as one. */
function frameNumber(name: string): number | null {
  const m = /-(\d+)\.png$/.exec(name);
  return m ? Number(m[1]) : null;
}

/** numeric frame order (so `-10000` sorts after `-9999` once ffmpeg widens past 4 digits); ties, and anything that does not parse as a frame index, fall back to the name. */
function byFrameIndex(a: string, b: string): number {
  const na = frameNumber(a);
  const nb = frameNumber(b);
  if (na !== null && nb !== null && na !== nb) return na - nb;
  return a.localeCompare(b);
}

/** the frames of one segment, in order, as absolute paths; a missing dir lists nothing. */
export async function listFrames(dir: string, segment: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(`${segment}-`) && n.endsWith('.png'))
    .sort(byFrameIndex)
    .map((n) => path.join(dir, n));
}
