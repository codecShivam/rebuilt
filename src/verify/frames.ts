import fs from 'node:fs/promises';
import path from 'node:path';
import type { PNG } from 'pngjs';
import { resolveFfmpeg } from '../capture/ffmpeg';
import { listFrames, splitVideo } from '../capture/motion';
import { MOTION, type ViewportName } from '../pack/defaults';
import { diffPngs, readPng, scalePng, writePng } from '../pack/image';
import { UNIT_FILES } from '../pack/paths';
import type { FrameReport, MotionInfo, Rect } from '../pack/schemas';
import { columnOf, rowOf } from './pixel';

/**
 * the frames of one segment of a unit's viewport: from frames/ when they were kept, else
 * split again from the video into `scratch` at the segment's recorded start. nothing when
 * there is no video, or no ffmpeg.
 */
export async function framesFor(
  unitDir: string,
  viewport: ViewportName,
  motion: MotionInfo,
  segment: string,
  scratch: string,
  resolve: () => Promise<string> = resolveFfmpeg,
): Promise<string[]> {
  const vdir = path.join(unitDir, viewport);
  const kept = await listFrames(path.join(vdir, UNIT_FILES.frames), segment);
  if (kept.length) return kept;
  const seg = motion.segments.find((s) => s.name === segment);
  if (!motion.video || !seg) return [];
  let ffmpeg: string;
  try {
    ffmpeg = await resolve();
  } catch {
    return [];
  }
  const outDir = path.join(scratch, viewport);
  try {
    await splitVideo({
      ffmpeg,
      video: path.join(vdir, motion.video),
      outDir,
      segment,
      start: seg.start,
      // the segment's own length, not the cap: a load that ended at settle is shorter than one
      seconds: seg.seconds,
      fps: motion.fps,
      maxFrames: MOTION.maxFramesPerSegment,
    });
  } catch {
    // a split that exits non-zero (a truncated recording, a full disk) is a lost report, the
    // same as no ffmpeg at all: the empty list becomes the report's note, and nothing gates
    return [];
  }
  return listFrames(outDir, segment);
}

/** up to `count` indices spread evenly over [0, n), the first and the last always in. */
export function stripIndices(n: number, count: number): number[] {
  if (n <= count) return Array.from({ length: n }, (_, i) => i);
  const out = new Set<number>();
  for (let k = 0; k < count; k++) out.add(Math.round((k * (n - 1)) / (count - 1)));
  return [...out].sort((a, b) => a - b);
}

export interface FramesInput {
  sourceDir: string;
  oursDir: string;
  sourceMotion: MotionInfo;
  oursMotion: MotionInfo;
  viewport: ViewportName;
  /** the source's masks in css px; a video frame is css-px sized, so they apply at scale 1 */
  masks: Rect[];
  outDir: string;
  label: string;
  /** where frames split from a video go; the caller removes it */
  scratch: string;
  /** the ffmpeg to split with; the real resolver unless a test injects one */
  resolveFfmpeg?: () => Promise<string>;
}

/**
 * the motion report for one viewport: frame i of a segment on the source against frame i on
 * ours (same fps, same start rule, so the same instant), diffed with the looser frame
 * threshold, and a strip of evenly spaced frames (source | ours | diff per row) written next
 * to the contact sheet. never gates.
 */
export async function compareFrames(
  input: FramesInput,
): Promise<{ reports: FrameReport[]; artefacts: string[] }> {
  const reports: FrameReport[] = [];
  const artefacts: string[] = [];
  for (const seg of input.sourceMotion.segments) {
    const source = await framesFor(
      input.sourceDir,
      input.viewport,
      input.sourceMotion,
      seg.name,
      path.join(input.scratch, 'source'),
      input.resolveFfmpeg,
    );
    const ours = await framesFor(
      input.oursDir,
      input.viewport,
      input.oursMotion,
      seg.name,
      path.join(input.scratch, 'ours'),
      input.resolveFfmpeg,
    );
    const n = Math.min(source.length, ours.length);
    if (n === 0) {
      const why = 'no video, no ffmpeg, or a load that settled before the first frame';
      reports.push({
        viewport: input.viewport,
        segment: seg.name,
        compared: 0,
        meanScore: 0,
        maxScore: 0,
        worstFrame: 0,
        strip: null,
        note:
          source.length === 0 && ours.length === 0
            ? `no frames on either side: ${why}`
            : source.length === 0
              ? `no source frames: ${why}`
              : `no frames on ours: ${why}`,
      });
      continue;
    }
    const scores: number[] = [];
    const picks = new Set(stripIndices(n, MOTION.stripFrames));
    const rows: PNG[] = [];
    for (let i = 0; i < n; i++) {
      const a = await readPng(source[i]!);
      const b = await readPng(ours[i]!);
      const r = diffPngs(a, b, { threshold: MOTION.frameThreshold, masks: input.masks, scale: 1 });
      scores.push(r.score);
      if (picks.has(i)) {
        rows.push(rowOf([a, b, r.diff].map((p) => scalePng(p, MOTION.stripPanelWidth))));
      }
    }
    const worst = scores.reduce((best, s, i) => (s > scores[best]! ? i : best), 0);
    const strip = path.join(input.outDir, `${input.label}.${input.viewport}.${seg.name}.strip.png`);
    await fs.mkdir(input.outDir, { recursive: true });
    await writePng(strip, columnOf(rows));
    artefacts.push(strip);
    reports.push({
      viewport: input.viewport,
      segment: seg.name,
      compared: n,
      meanScore: scores.reduce((s, x) => s + x, 0) / n,
      maxScore: scores[worst]!,
      worstFrame: worst + 1,
      strip,
      note: null,
    });
  }
  return { reports, artefacts };
}
