import { PER_UNIT_ERROR_CODES, VIEWPORT_NAMES } from '../pack/defaults';
import { loadManifest, saveManifest } from '../pack/io';
import { unitIdForSection } from '../pack/ids';
import { PackPaths } from '../pack/paths';
import { actionsFor, blockUnit } from '../pack/units';
import { capturePageUnit } from './pipeline';
import { replayActions } from './replay';
import { viewportFor, type Session } from './session';

/** capture every planned page and state unit. a state is its page reached by replaying its actions. */
export async function captureAll(opts: {
  root: string;
  session: Session;
  only?: string;
  /** keep frames/ next to each video; the video is always kept */
  keepFrames?: boolean;
}): Promise<{ captured: string[]; blocked: string[] }> {
  const manifest = await loadManifest(opts.root);
  const pack = new PackPaths(opts.root);
  const captured: string[] = [];
  const blocked: string[] = [];
  const now = () => new Date().toISOString();
  if (opts.session.attached) {
    // nothing is emulated over cdp: pages are resized to the viewport, and the pack records
    // the attached chrome's own pixel ratio so crops and masks are cut at the right scale
    manifest.capture.attach = true;
    for (const name of VIEWPORT_NAMES) {
      manifest.viewports[name] = viewportFor(opts.session, manifest.viewports[name]);
    }
    await saveManifest(opts.root, manifest);
  }
  for (const [id, unit] of Object.entries(manifest.units)) {
    if (unit.status !== 'planned') continue;
    if (unit.kind !== 'page' && unit.kind !== 'state') continue;
    if (opts.only && opts.only !== id) continue;
    if (!unit.url) continue;
    const isState = unit.kind === 'state';
    // a state is captured where its discovery pass reached it; a viewport it does not list
    // has no trigger to replay and would only be skipped after a failed replay
    const names = VIEWPORT_NAMES.filter((v) => !unit.reachable || unit.reachable.includes(v));
    try {
      const summary = await capturePageUnit({
        pack,
        unitId: id,
        url: unit.url,
        viewports: names.map((v) => manifest.viewports[v]),
        session: opts.session,
        reachedBy: isState ? 'replay' : 'goto',
        prepare: isState
          ? (page, _mark, viewport) => replayActions(page, actionsFor(unit, viewport.name))
          : undefined,
        motion: { fps: manifest.capture.fps, keepFrames: opts.keepFrames ?? false },
        dynamic: {
          shots: manifest.capture.dynamicShots,
          gap: manifest.capture.dynamicGap,
        },
      });
      if (unit.kind === 'page') {
        const sectionIds = summary.sections.map((s) => unitIdForSection(id, s.id));
        for (const sid of sectionIds) {
          manifest.units[sid] = {
            kind: 'section',
            status: 'captured',
            dependsOn: [],
            rounds: 0,
            updatedAt: now(),
          };
        }
        unit.dependsOn = sectionIds;
      }
      unit.status = 'captured';
      unit.updatedAt = now();
      captured.push(id);
    } catch (err) {
      // a dead url, a challenge page, a trigger that has vanished or an input the manifest
      // never filled in is that unit's problem; it must not abort every other planned unit
      const code = (err as Error & { code?: string }).code;
      if (!code || !PER_UNIT_ERROR_CODES.includes(code)) throw err;
      blockUnit(manifest, id, { code, message: (err as Error).message }, now());
      blocked.push(id);
    } finally {
      await saveManifest(opts.root, manifest);
    }
  }
  return { captured, blocked };
}
