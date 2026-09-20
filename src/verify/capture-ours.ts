import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { capturePageUnit, type CaptureSummary, type Prepare } from '../capture/pipeline';
import { replayActions } from '../capture/replay';
import type { Session } from '../capture/session';
import { VIEWPORT_NAMES, type ViewportName } from '../pack/defaults';
import { parseUnitId, type ParsedUnitId } from '../pack/ids';
import { readJson } from '../pack/io';
import { PackPaths } from '../pack/paths';
import { StepsFileSchema, type Manifest } from '../pack/schemas';
import { actionsFor } from '../pack/units';

/** the source url's path and query on the target origin. */
export function rebase(sourceUrl: string, target: string): string {
  const u = new URL(sourceUrl);
  return new URL(u.pathname + u.search, target).toString();
}

export interface Walk {
  unitId: string;
  url: string;
  prepare?: Prepare;
  /** the viewports the source captured; ours is captured at the same ones */
  viewports: ViewportName[];
}

export interface OursOptions {
  root: string;
  manifest: Manifest;
  unitId: string;
  target: string;
  session: Session;
}

/** where ours starts and how it is reached: a page by its url, a state by replaying its actions there, a flow step by replaying the flow up to it from its start. */
export async function walkFor(opts: OursOptions, parsed: ParsedUnitId): Promise<Walk> {
  if (parsed.kind === 'flowStep') {
    const flow = opts.manifest.flows[parsed.flow];
    if (!flow || !flow.steps.includes(opts.unitId)) {
      throw new Error(`${opts.unitId} is not a captured step of flow "${parsed.flow}"`);
    }
    const file = await readJson(StepsFileSchema, new PackPaths(opts.root).stepsFile(parsed.flow));
    // the step's position is in its slug: the flow's step list skips scroll-only steps, so an
    // index into it is not a position in the steps file
    const m = /^step-(\d+)-([a-z]+)/.exec(parsed.step);
    const n = Number(m?.[1] ?? NaN);
    if (!m || !Number.isInteger(n) || n < 1 || n > file.steps.length) {
      throw new Error(`${opts.unitId} names a step the steps file does not have`);
    }
    // the slug also names the step's kind (stepSlug); a mismatch means the id and the file
    // come from different recordings, and a walk would verify the wrong action
    const kind = file.steps[n - 1]!.kind;
    if (kind !== m[2]) {
      throw new Error(
        `${opts.unitId} names step ${n} as a ${m[2]}, but step ${n} in the steps file is ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}; re-record the flow or rerun replay`,
      );
    }
    const upTo = file.steps.slice(0, n);
    // ours is walked, not addressed: the start url is rebased and the same steps replayed there
    return {
      unitId: opts.unitId,
      url: rebase(file.start, opts.target),
      prepare: async (page, mark) => {
        await replayActions(page, upTo.slice(0, -1), flow.inputs);
        mark();
        await replayActions(page, upTo.slice(-1), flow.inputs);
      },
      viewports: VIEWPORT_NAMES,
    };
  }
  const pageUnitId = parsed.kind === 'section' ? parsed.parent : opts.unitId;
  const unit = opts.manifest.units[pageUnitId];
  if (!unit?.url) throw new Error(`unit ${pageUnitId} has no url in the manifest`);
  const url = rebase(unit.url, opts.target);
  if (parsed.kind === 'state') {
    // a state the source reached at one viewport only is held to that viewport only
    const viewports = VIEWPORT_NAMES.filter((v) => !unit.reachable || unit.reachable.includes(v));
    return {
      unitId: opts.unitId,
      url,
      prepare: (page, _mark, viewport) => replayActions(page, actionsFor(unit, viewport.name)),
      viewports,
    };
  }
  return { unitId: pageUnitId, url, viewports: VIEWPORT_NAMES };
}

/**
 * capture the target's version of a unit into a temp pack with the same pipeline. video is
 * recorded and its frames kept: the frames report reads them before cleanup removes the pack.
 */
export async function captureOurs(
  opts: OursOptions,
): Promise<{ pack: PackPaths; summary: CaptureSummary; cleanup(): Promise<void> }> {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'site-ours-'));
  try {
    const pack = new PackPaths(tmpRoot);
    const walk = await walkFor(opts, parseUnitId(opts.unitId));
    const summary = await capturePageUnit({
      pack,
      unitId: walk.unitId,
      url: walk.url,
      viewports: walk.viewports.map((v) => opts.manifest.viewports[v]),
      session: opts.session,
      reachedBy: 'verify',
      prepare: walk.prepare,
      motion: { fps: opts.manifest.capture.fps, keepFrames: true },
      // ours is shot the same way the source was, or a carousel the source masked would
      // change under the comparison
      dynamic: {
        shots: opts.manifest.capture.dynamicShots,
        gap: opts.manifest.capture.dynamicGap,
      },
    });
    return { pack, summary, cleanup: () => fs.rm(tmpRoot, { recursive: true, force: true }) };
  } catch (err) {
    // a failed cleanup must never replace the capture error the caller needs to read
    try {
      await fs.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      /* the temp root outlives this run; the capture error is the one worth throwing */
    }
    throw err;
  }
}
