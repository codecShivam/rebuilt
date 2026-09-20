import { ERROR_CODES, PER_UNIT_ERROR_CODES } from '../pack/defaults';
import { stepSlug, unitIdForFlowStep } from '../pack/ids';
import { loadManifest, readJson, saveManifest } from '../pack/io';
import { PackPaths } from '../pack/paths';
import { blockUnit } from '../pack/units';
import { StepsFileSchema, type Action } from '../pack/schemas';
import { capturePageUnit } from './pipeline';
import { replayActions, ReplayError } from './replay';
import type { Session } from './session';

/** the name a step is known by: its target's accessible name, else its text, else nothing. */
export function stepName(action: Action): string {
  return action.target?.role?.name ?? action.target?.text ?? '';
}

/**
 * capture every step of a recorded flow as a flow-step unit. each step is reached by
 * replaying the steps up to it from the start url, in a fresh context per viewport, so
 * every step is deterministic and can be recaptured or verified on its own.
 *
 * a step that fails blocks itself and every step after it (they can only be reached through
 * it), and the walk stops there: what was captured stays in the manifest, so a rerun and a
 * reader both know how far the flow got.
 */
export async function replayFlow(opts: {
  root: string;
  flow: string;
  session: Session;
  /** keep frames/ next to each video; the video is always kept */
  keepFrames?: boolean;
}): Promise<{ captured: string[]; blocked: string[] }> {
  const pack = new PackPaths(opts.root);
  const manifest = await loadManifest(opts.root);
  const file = await readJson(StepsFileSchema, pack.stepsFile(opts.flow));
  const inputs = manifest.flows[opts.flow]?.inputs ?? {};
  // every input is checked before the first capture, so a missing one stops the run empty-handed
  const missing = [
    ...new Set(
      file.steps.flatMap((s) =>
        s.input && (inputs[s.input] === null || inputs[s.input] === undefined) ? [s.input] : [],
      ),
    ),
  ];
  if (missing.length) {
    throw new ReplayError(
      `flow "${opts.flow}" needs inputs: ${missing.join(', ')}; set them under manifest.flows.${opts.flow}.inputs`,
      ERROR_CODES.needsInput,
    );
  }
  const now = () => new Date().toISOString();
  const captured: string[] = [];
  const blocked: string[] = [];
  let previous: string | undefined;
  let failed: string | undefined;
  for (const step of file.steps) {
    // a scroll on its own is not a unit: the pipeline returns the page to the top before its
    // shots, so the capture would equal the previous step's. it is replayed on the way to the
    // next step (upTo holds it); a trailing scroll leads nowhere and gets no unit either
    if (step.kind === 'scroll') continue;
    const id = unitIdForFlowStep(opts.flow, stepSlug(step.n, step.kind, stepName(step)));
    const base = {
      kind: 'flowStep' as const,
      url: step.url,
      dependsOn: previous ? [previous] : [],
      rounds: 0,
    };
    previous = id;
    if (failed) {
      manifest.units[id] = { ...base, status: 'planned', updatedAt: now() };
      blockUnit(
        manifest,
        id,
        {
          code: ERROR_CODES.dependency,
          message: `only reachable through ${failed}, which is blocked`,
          hint: 'fix that step and rerun the flow.',
        },
        now(),
      );
      blocked.push(id);
      manifest.flows[opts.flow] = { steps: [...captured], inputs };
      await saveManifest(opts.root, manifest);
      continue;
    }
    const upTo = file.steps.slice(0, step.n);
    try {
      await capturePageUnit({
        pack,
        unitId: id,
        url: file.start,
        viewports: [manifest.viewports.mobile, manifest.viewports.desktop],
        session: opts.session,
        reachedBy: 'replay',
        // the walk up to the step, then the mark, then the step: the video's interaction
        // segment starts at this step's own action, not at step 1
        prepare: async (page, mark) => {
          await replayActions(page, upTo.slice(0, -1), inputs);
          mark();
          await replayActions(page, upTo.slice(-1), inputs);
        },
        motion: { fps: manifest.capture.fps, keepFrames: opts.keepFrames ?? false },
        dynamic: {
          shots: manifest.capture.dynamicShots,
          gap: manifest.capture.dynamicGap,
        },
      });
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (!code || !PER_UNIT_ERROR_CODES.includes(code)) throw err;
      manifest.units[id] = { ...base, status: 'planned', updatedAt: now() };
      blockUnit(
        manifest,
        id,
        {
          code,
          message: (err as Error).message,
          hint: "re-record the flow, or fix the step's target on the page.",
        },
        now(),
      );
      blocked.push(id);
      failed = id;
      manifest.flows[opts.flow] = { steps: [...captured], inputs };
      await saveManifest(opts.root, manifest);
      continue;
    }
    manifest.units[id] = { ...base, status: 'captured', updatedAt: now() };
    captured.push(id);
    // only the steps that were captured are the flow's steps: verify walks them by index
    manifest.flows[opts.flow] = { steps: [...captured], inputs };
    await saveManifest(opts.root, manifest);
  }
  return { captured, blocked };
}
