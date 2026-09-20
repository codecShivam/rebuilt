import fs from 'node:fs/promises';
import path from 'node:path';
import { freezeAnimations } from '../capture/freeze';
import { coded } from '../capture/pipeline';
import { openPage, type Session } from '../capture/session';
import { settle } from '../capture/settle';
import { ERROR_CODES, VIEWPORT_NAMES, type ViewportName } from '../pack/defaults';
import { parseUnitId } from '../pack/ids';
import { loadManifest, readJson } from '../pack/io';
import { PackPaths, UNIT_FILES } from '../pack/paths';
import { SectionsFileSchema, type Rect } from '../pack/schemas';
import { walkFor } from './capture-ours';

export interface ShotFile {
  viewport: ViewportName;
  file: string;
  /** a section's box on the rebuild, in css px; null for a full page */
  box: Rect | null;
}

export interface ShotResult {
  /** in viewport order, the full page first and the section's crop after it */
  files: ShotFile[];
  /** what was not shot and why: a viewport the source has no capture at, a section not found */
  notes: string[];
}

/**
 * `site shot`: the rebuild as a worker's own eyes see it, without the verify pipeline. the
 * unit's page is opened at every viewport the source captured, reached the way verify reaches
 * it (a state by its actions, a flow step by its flow), settled and frozen in the pipeline's
 * order, then the full page is shot and, for a section, the crop of its element: the one that
 * carries the `data-section`, or failing that the source's own selector (the fixture served
 * as its own rebuild carries no attributes). cheap enough to run after every edit.
 */
export async function shootUnit(opts: {
  root: string;
  unitId: string;
  target: string;
  session: Session;
  outDir: string;
  viewports?: ViewportName[];
}): Promise<ShotResult> {
  const manifest = await loadManifest(opts.root);
  const parsed = parseUnitId(opts.unitId);
  const walk = await walkFor(
    { root: opts.root, manifest, unitId: opts.unitId, target: opts.target, session: opts.session },
    parsed,
  );
  const section =
    parsed.kind === 'section'
      ? (
          await readJson(
            SectionsFileSchema,
            path.join(new PackPaths(opts.root).unitDir(opts.unitId), UNIT_FILES.sections),
          )
        ).find((s) => s.id === parsed.sectionId)
      : undefined;
  if (parsed.kind === 'section' && !section)
    throw new Error(`${parsed.sectionId} is not in the pack`);
  await fs.mkdir(opts.outDir, { recursive: true });
  const result: ShotResult = { files: [], notes: [] };
  for (const vp of VIEWPORT_NAMES) {
    if (opts.viewports && !opts.viewports.includes(vp)) continue;
    if (!walk.viewports.includes(vp)) {
      result.notes.push(`${vp}: the source has no capture at this viewport`);
      continue;
    }
    const viewport = manifest.viewports[vp];
    const opened = await openPage(opts.session, viewport);
    try {
      const page = opened.page;
      // the same navigation check capturePageUnit makes: a rebuild that 404s or refuses the
      // connection is an error with a code, not a png of next's own error page
      const response = await page
        .goto(walk.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        .catch((err: unknown) => {
          const why = err instanceof Error ? err.message : String(err);
          throw coded(`${walk.url} could not be loaded: ${why}`, ERROR_CODES.navigationFailed);
        });
      if (!response) throw coded(`no response for ${walk.url}`, ERROR_CODES.navigationFailed);
      if (response.status() >= 400) {
        throw coded(`${walk.url} answered http ${response.status()}`, ERROR_CODES.httpError);
      }
      await page.waitForLoadState('load', { timeout: 60_000 }).catch(() => {});
      // the pipeline's order: settle with the sweep, reach the state, settle without it, freeze
      await settle(page);
      if (walk.prepare) {
        await walk.prepare(page, () => {}, viewport);
        await settle(page, { scroll: false });
      }
      await freezeAnimations(page);
      const full = path.join(opts.outDir, `${vp}.full.png`);
      await page.screenshot({ path: full, fullPage: true, type: 'png' });
      result.files.push({ viewport: vp, file: full, box: null });
      if (!section) continue;
      const byAttribute = page.locator(`[data-section="${section.id}"]`).first();
      const el = (await byAttribute.count()) ? byAttribute : page.locator(section.selector).first();
      const box = (await el.count()) ? await el.boundingBox() : null;
      // a box under a pixel either way is a hidden or empty element: playwright refuses a clip
      // of that size, and a note reads better than its error
      if (!box || box.width < 1 || box.height < 1) {
        result.notes.push(
          box
            ? `${vp}: the element for ${section.id} is ${box.width} by ${box.height} css px, too small to crop; it is hidden or empty`
            : `${vp}: no element carries data-section="${section.id}" and nothing matches ${section.selector}`,
        );
        continue;
      }
      const crop = path.join(opts.outDir, `${vp}.${section.id}.png`);
      // the page is at the top after settle, so the viewport box is the page box
      await page.screenshot({ path: crop, fullPage: true, type: 'png', clip: box });
      result.files.push({ viewport: vp, file: crop, box });
    } finally {
      await opened.release();
    }
  }
  return result;
}
