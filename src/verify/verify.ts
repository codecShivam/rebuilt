import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Session } from '../capture/session';
import {
  DEFAULT_PIXEL_GATE,
  PER_UNIT_ERROR_CODES,
  VIEWPORT_NAMES,
  type ViewportName,
} from '../pack/defaults';
import { parseUnitId } from '../pack/ids';
import { loadManifest, readJson } from '../pack/io';
import { PackPaths, safeUnitName, UNIT_FILES } from '../pack/paths';
import {
  AnimationsFileSchema,
  PageMetaSchema,
  SectionsFileSchema,
  StylesFileSchema,
  type FrameReport,
  type Rect,
  type VerifyResult,
} from '../pack/schemas';
import { compareAnimations } from './animations';
import { captureOurs } from './capture-ours';
import { compareFrames } from './frames';
import { comparePixels } from './pixel';
import { writeVerifyResult } from './report';
import { compareStructure, matchSection } from './structure';
import { compareStyles } from './styles';

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** the copies verify leaves in its outDir of what ours looked like: `full`, or a source section id */
export function oursPngName(viewport: ViewportName, label: string): string {
  return `ours.${viewport}.${label}.png`;
}

/**
 * an artefact verify itself writes: a copy of ours (oursPngName), a diff, a contact sheet or a
 * motion strip. the pack's own pngs are `full.png`, `section-<id>.png` and `frames/*`, and none
 * of them is one of these: `--out` names any dir the caller likes, the round's own rule admits
 * one, and a worker that pointed it into the pack "to see the diff beside the source" must not
 * lose the capture.
 */
function ourArtefact(name: string): boolean {
  const n = name.toLowerCase();
  return (
    (n.startsWith('ours.') && n.endsWith('.png')) ||
    n.endsWith('.diff.png') ||
    n.endsWith('.sheet.png') ||
    n.endsWith('.strip.png')
  );
}

/** what an earlier verify left in this outDir; a dir that is not there yet holds none */
async function clearArtefacts(outDir: string): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(outDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (ourArtefact(name)) await fs.rm(path.join(outDir, name), { force: true });
  }
}

export async function verifyUnit(opts: {
  root: string;
  unitId: string;
  target: string;
  session: Session;
  outDir?: string;
  gate?: number;
}): Promise<VerifyResult> {
  const manifest = await loadManifest(opts.root);
  const pack = new PackPaths(opts.root);
  const parsed = parseUnitId(opts.unitId);
  const sourceDir = pack.unitDir(opts.unitId);
  const unit = manifest.units[opts.unitId];
  const gate = opts.gate ?? unit?.thresholdOverride ?? DEFAULT_PIXEL_GATE;
  const outDir = opts.outDir ?? path.join(opts.root, 'runs', 'verify', safeUnitName(opts.unitId));

  // an earlier run's artefacts in the same outDir would outlive the result that named them:
  // the stop hook reuses verify-hook across a round's holds, and `site verify` reuses
  // runs/verify/<unit> across calls, so a pass after a fail would leave the old diffs beside a
  // verify.json that lists none of them. only verify's own names go
  await clearArtefacts(outDir);

  const sourceSections = await readJson(
    SectionsFileSchema,
    path.join(sourceDir, UNIT_FILES.sections),
  );
  const sourceStyles = await readJson(StylesFileSchema, path.join(sourceDir, UNIT_FILES.styles));
  const sourceMeta = await readJson(PageMetaSchema, path.join(sourceDir, UNIT_FILES.meta));
  const sourceAnimations = await readJson(
    AnimationsFileSchema,
    path.join(sourceDir, UNIT_FILES.animations),
  );

  // the frames scratch is taken before the capture, not between it and the try below: a
  // mkdtemp that failed there would leave the temp ours pack behind with nothing to remove it
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'site-frames-'));

  // captureOurs cleans up its own temp root on failure, so nothing here needs to compensate
  // for a rejected call. a per-unit failure to reach the rebuild (a dev server that is down, a
  // 4xx, a state the rebuild cannot reach) is a failed verify with the reason in `missing`, and
  // it writes verify.json: the orchestrator and the stop hook read the verdict from the file.
  // anything uncoded is a bug and still throws.
  let ours: Awaited<ReturnType<typeof captureOurs>>;
  try {
    ours = await captureOurs({
      root: opts.root,
      manifest,
      unitId: opts.unitId,
      target: opts.target,
      session: opts.session,
    });
  } catch (err) {
    // there is no ours to compare frames against, either way out of here
    await fs.rm(scratch, { recursive: true, force: true });
    const code = (err as Error & { code?: string }).code;
    if (!code || !PER_UNIT_ERROR_CODES.includes(code)) throw err;
    const result: VerifyResult = {
      unitId: opts.unitId,
      target: opts.target,
      verdict: 'fail',
      gate,
      pixel: { mobile: null, desktop: null },
      heightDelta: { mobile: null, desktop: null },
      styles: [],
      structure: [],
      animations: [],
      frames: [],
      missing: [`ours: ${code}: ${(err as Error).message}`],
      artefacts: [],
    };
    const verifyJson = await writeVerifyResult(outDir, result);
    return { ...result, artefacts: [verifyJson] };
  }
  try {
    const oursDir = ours.summary.unitDir;
    const oursSections = ours.summary.sections;
    const oursMeta = ours.summary.meta;
    const oursStyles = await readJson(StylesFileSchema, path.join(oursDir, UNIT_FILES.styles));
    const oursAnimations = await readJson(
      AnimationsFileSchema,
      path.join(oursDir, UNIT_FILES.animations),
    );

    const section =
      parsed.kind === 'section' ? sourceSections.find((s) => s.id === parsed.sectionId) : undefined;
    if (parsed.kind === 'section' && !section)
      throw new Error(`section ${parsed.sectionId} not in pack`);
    const oursSection = section ? matchSection(section, oursSections) : undefined;
    const missing: string[] = [];
    if (section && !oursSection) missing.push(section.id);

    const pixel: VerifyResult['pixel'] = { mobile: null, desktop: null };
    const heightDelta: VerifyResult['heightDelta'] = { mobile: null, desktop: null };
    for (const vp of VIEWPORT_NAMES) {
      const scale = manifest.viewports[vp].scale;
      const sourceBox: Rect | null = section ? section.bbox[vp] : null;
      const oursBox: Rect | null = section ? (oursSection?.bbox[vp] ?? null) : null;
      if (section && (!sourceBox || !oursBox)) continue;
      const sourceFull = path.join(sourceDir, vp, UNIT_FILES.full);
      const oursFull = path.join(oursDir, vp, UNIT_FILES.full);
      // a state the source itself could only reach at one viewport has no shot at the other:
      // nothing to compare, and nothing to hold the rebuild to
      if (!(await exists(sourceFull))) continue;
      // the source reached it and we did not: that is the rebuild missing a viewport, so the
      // unit fails rather than quietly scoring on the half that worked
      if (!(await exists(oursFull))) {
        missing.push(`${vp}/${UNIT_FILES.full}`);
        heightDelta[vp] = null;
        continue;
      }
      const r = await comparePixels({
        sourceFull,
        oursFull,
        sourceBox,
        oursBox,
        masks: sourceMeta.masks[vp],
        scale,
        viewport: vp,
        outDir,
        label: section ? section.id : 'page',
      });
      pixel[vp] = {
        score: r.score,
        mismatched: r.mismatched,
        total: r.total,
        diffPng: r.diffPng,
        contactSheet: r.contactSheet,
      };
      heightDelta[vp] = r.heightDelta;
    }

    const within = section
      ? (p: string) => p === section.path || p.startsWith(section.path + '>')
      : undefined;
    const styleResult = compareStyles(
      sourceStyles,
      oursStyles,
      VIEWPORT_NAMES as ViewportName[],
      within,
    );
    missing.push(...styleResult.missing);
    const structure = compareStructure(sourceSections, oursSections, section?.id);
    const animations = compareAnimations(
      sourceAnimations,
      oursAnimations,
      VIEWPORT_NAMES as ViewportName[],
      within,
    );

    // the motion report: whole units only (a video is per viewport, not per section); it
    // reports and never gates
    const frames: FrameReport[] = [];
    const strips: string[] = [];
    if (!section) {
      for (const vp of VIEWPORT_NAMES) {
        const sourceMotion = sourceMeta.motion[vp];
        const oursMotion = oursMeta.motion[vp];
        if (!sourceMotion || !oursMotion) continue;
        const r = await compareFrames({
          sourceDir,
          oursDir,
          sourceMotion,
          oursMotion,
          viewport: vp,
          masks: sourceMeta.masks[vp],
          outDir,
          label: 'page',
          scratch,
        });
        frames.push(...r.reports);
        strips.push(...r.artefacts);
      }
    }

    const pixelFail = VIEWPORT_NAMES.some((vp) => (pixel[vp]?.score ?? 0) > gate);
    const verdict: VerifyResult['verdict'] =
      pixelFail || styleResult.findings.length > 0 || animations.length > 0 || missing.length > 0
        ? 'fail'
        : 'pass';

    // verify.json has to name the images it describes, so the artefact list is complete
    // before the write; only the returned object also names verify.json itself.
    const artefacts: string[] = [];
    for (const vp of VIEWPORT_NAMES)
      if (pixel[vp]) artefacts.push(pixel[vp]!.diffPng, pixel[vp]!.contactSheet);
    artefacts.push(...strips);
    // ours is a temp pack that cleanup removes: its shots are copied next to the diff, so a
    // reviewer (and a person) can see source, ours and diff together afterwards
    await fs.mkdir(outDir, { recursive: true });
    for (const vp of VIEWPORT_NAMES) {
      const oursFull = path.join(oursDir, vp, UNIT_FILES.full);
      if (!(await exists(oursFull))) continue;
      const full = path.join(outDir, oursPngName(vp, 'full'));
      await fs.copyFile(oursFull, full);
      artefacts.push(full);
      if (section && oursSection?.bbox[vp]) {
        const crop = path.join(oursDir, vp, UNIT_FILES.section(oursSection.id));
        if (await exists(crop)) {
          const to = path.join(outDir, oursPngName(vp, section.id));
          await fs.copyFile(crop, to);
          artefacts.push(to);
        }
      }
    }

    const result: VerifyResult = {
      unitId: opts.unitId,
      target: opts.target,
      verdict,
      gate,
      pixel,
      heightDelta,
      styles: styleResult.findings,
      structure,
      animations,
      frames,
      missing,
      artefacts,
    };
    const verifyJson = await writeVerifyResult(outDir, result);
    return { ...result, artefacts: [...artefacts, verifyJson] };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
    await ours.cleanup();
  }
}
