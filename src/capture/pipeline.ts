import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page, Video } from 'playwright';
import type { PNG } from 'pngjs';
import type { Viewport, ViewportName } from '../pack/defaults';
import { ERROR_CODES, MASK_HINT_MAX_VIEWPORTS, MOTION } from '../pack/defaults';
import { writeDirAtomic, writeJson } from '../pack/io';
import { sectionIdFor } from '../pack/ids';
import { PackPaths, UNIT_FILES } from '../pack/paths';
import type {
  AnimationsFile,
  ElementAnimation,
  KeyframeStop,
  MotionInfo,
  ObservedAnimation,
  PageMeta,
  Rect,
  SectionsFile,
  StylesFile,
  TextFile,
} from '../pack/schemas';
import { cropPng, writePng } from '../pack/image';
import {
  canonicaliseKeyframes,
  keyframeStopsOf,
  observeAnimations,
  readCssomInPage,
  type CssomRead,
} from './animations';
import { AssetStore, attachAssetCapture } from './assets';
import { extractPage, STYLE_PROPS, type ExtractResult } from './browser/extract';
import { inPage } from './browser/in-page';
import { parseStylesheet, type ParsedStylesheet } from './css';
import { resolveFfmpeg } from './ffmpeg';
import { mapFonts, matchingFaces, uniqueFaces, type FontFaceSource } from './fonts';
import { freezeAnimations } from './freeze';
import { dynamicMasks } from './masks';
import { splitVideo } from './motion';
import { openPage, type Session } from './session';
import { settle } from './settle';
import { buildSnapshot } from './snapshot';

export interface MotionOptions {
  /** frames per second the video is split at (manifest.capture.fps) */
  fps: number;
  /** keep frames/ next to the video; the video itself is always kept */
  keepFrames: boolean;
  /** the ffmpeg to split with; the real resolver unless a test injects one */
  resolveFfmpeg?: () => Promise<string>;
}

/** manifest.capture's rest-shot settings, so a pack with a slow carousel can widen the span. */
export interface DynamicOptions {
  shots: number;
  gap: number;
}

export interface CaptureSummary {
  unitDir: string;
  sections: SectionsFile;
  meta: PageMeta;
}

/**
 * reach the unit on a loaded, settled page. `mark` may be called right before the action
 * that is the unit's own interaction (a flow step's last action); until then the interaction
 * is taken to start when prepare starts.
 */
export type Prepare = (page: Page, mark: () => void, viewport: Viewport) => Promise<void>;

/** what the captured stylesheet bodies declare, in the spellings the cssom would report. */
interface SheetRead {
  keyframes: Record<string, KeyframeStop[]>;
  fontFaces: FontFaceSource[];
  parseErrors: { url: string; errors: number }[];
}

interface ViewportShot {
  viewport: Viewport;
  extract: ExtractResult;
  cssom: CssomRead;
  sheets: SheetRead;
  observed: ObservedAnimation[];
  full: PNG;
  masks: Rect[];
  /** seconds from the page's creation to the interaction; null for a page unit */
  prepareAt: number | null;
  /** ms from the page's creation to the moment settle began */
  settleAt: number;
}

interface ViewportCapture extends ViewportShot {
  motion: MotionInfo | null;
}

const CHALLENGE_TITLE =
  /just a moment|checking your browser|attention required|verify you are human|cf-chl|captcha/i;
// the body text of an ordinary page mentions captcha often enough ("this form is protected
// by reCAPTCHA") that the bare word cannot stand in for a challenge; only the wording a
// challenge interstitial actually uses counts here.
const CHALLENGE_BODY = /cf-chl|challenge-platform|verify you are human|checking your browser/i;

/** css generic families: a page always reports these loaded, and no file backs them. */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
]);

const ANIMATION_PROPS = STYLE_PROPS.filter((p) => p.startsWith('animation-'));
const TRANSITION_PROPS = STYLE_PROPS.filter((p) => p.startsWith('transition-'));

/** an error the caller can branch on: a unit blocks on a code, never on a message. */
export function coded(message: string, code: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

/** an element's animation and transition longhands when it declares any; nothing otherwise. */
function animationOf(el: ExtractResult['elements'][number]): ElementAnimation | null {
  const pick = (props: string[]) => Object.fromEntries(props.map((p) => [p, el.styles[p] ?? '']));
  const animation =
    (el.styles['animation-name'] ?? 'none') !== 'none' ? pick(ANIMATION_PROPS) : null;
  const durations = (el.styles['transition-duration'] ?? '0s').split(',').map((d) => d.trim());
  const transition = durations.some((d) => d !== '0s') ? pick(TRANSITION_PROPS) : null;
  if (!animation && !transition) return null;
  return { ref: el.ref, dataRef: el.dataRef, animation, transition };
}

/**
 * every captured stylesheet body's @keyframes and @font-face, canonicalised through the page
 * that is still open. the parse is cached by url on `cache`, which belongs to the unit: the
 * same sheet is parsed once however many viewports the unit has. the canonicalisation has to
 * happen here rather than after the loop, because it needs a live page.
 */
async function readStylesheets(
  page: Page,
  store: AssetStore,
  cache: Map<string, ParsedStylesheet>,
): Promise<SheetRead> {
  const keyframes: Record<string, KeyframeStop[]> = {};
  const fontFaces: FontFaceSource[] = [];
  const parseErrors: SheetRead['parseErrors'] = [];
  // the bodies are read off disk, so the store's in-flight writes have to have landed first
  await store.flush();
  for (const entry of store.entries) {
    if (entry.kind !== 'stylesheet') continue;
    let parsed = cache.get(entry.url);
    if (!parsed) {
      const body = await fs.readFile(path.join(store.dir, entry.file), 'utf8');
      parsed = parseStylesheet(body, entry.url);
      cache.set(entry.url, parsed);
    }
    // the first sheet to declare a name owns it, as it does in the cssom pass
    for (const [name, stops] of Object.entries(parsed.keyframes)) {
      if (!keyframes[name]) keyframes[name] = stops;
    }
    fontFaces.push(...parsed.fontFaces);
    if (parsed.parseErrors > 0) parseErrors.push({ url: entry.url, errors: parsed.parseErrors });
  }
  return { keyframes: await canonicaliseKeyframes(page, keyframes), fontFaces, parseErrors };
}

async function captureViewport(input: {
  page: Page;
  viewport: Viewport;
  url: string;
  prepare: Prepare | undefined;
  openedAt: number;
  store: AssetStore;
  /** the unit's parsed stylesheets, by url: shared across its viewports */
  sheetCache: Map<string, ParsedStylesheet>;
  dynamic: DynamicOptions | undefined;
}): Promise<ViewportShot> {
  const { page, viewport, url, prepare, openedAt, store } = input;
  // the observer goes first: the animations of a load start with the load
  const observer = await observeAnimations(page);
  try {
    const response = await page
      .goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      .catch((err: unknown) => {
        const why = err instanceof Error ? err.message : String(err);
        throw coded(`${url} could not be loaded: ${why}`, ERROR_CODES.navigationFailed);
      });
    if (!response) throw coded(`no response for ${url}`, ERROR_CODES.navigationFailed);
    if (response.status() >= 400) {
      throw coded(`${url} answered http ${response.status()}`, ERROR_CODES.httpError);
    }
    await page.waitForLoadState('load', { timeout: 60_000 }).catch(() => {});
    // settle first: the sweep loads lazy content and leaves the page at rest at the top.
    // only then reach the state, and wait again without the sweep, because the sweep moves
    // the pointer off a hovered menu and a modal with overflow: hidden on body defeats it.
    // the load is over here: the video after this instant is the sweep, which is the capture's
    // own doing and runs at its own pace, so the load segment stops here (finishMotion)
    const settleAt = Date.now() - openedAt;
    await settle(page);
    let prepareAt: number | null = null;
    if (prepare) {
      const mark = () => {
        prepareAt = (Date.now() - openedAt) / 1000;
        observer.mark('prepare');
      };
      mark();
      await prepare(page, mark, viewport);
      observer.mark('settle');
      await settle(page, { scroll: false });
    }
    // every animation is frozen after the state is reached, so a menu fade-in is captured at
    // its end state and two shots of the same page never disagree over animation phase.
    await freezeAnimations(page);
    const title = await page.title();
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) ?? '');
    if (CHALLENGE_TITLE.test(title) || CHALLENGE_BODY.test(bodyText)) {
      throw coded(`challenge page detected at ${url}`, ERROR_CODES.blockedBySite);
    }
    const extract = await page.evaluate(inPage(extractPage), {
      styleProps: STYLE_PROPS,
      minSectionHeight: 80,
      hintMaxViewports: MASK_HINT_MAX_VIEWPORTS,
    });
    const cssom = await page.evaluate(inPage(readCssomInPage, [keyframeStopsOf]), undefined);
    const observed = await observer.stop();
    // regions that change on their own become masks: the live element's own box, or the padded
    // cell when nothing owns the change (see masks.ts); the last rest shot is the page's shot
    const dyn = await dynamicMasks(page, viewport, input.dynamic ?? {});
    const masks = [...dyn.masks, ...extract.dynamicHints];
    const sheets = await readStylesheets(page, store, input.sheetCache);
    return {
      viewport,
      extract,
      cssom,
      sheets,
      observed,
      full: dyn.last,
      masks,
      prepareAt,
      settleAt,
    };
  } catch (err) {
    await observer.stop().catch(() => {});
    throw err;
  }
}

let ffmpegWarned = false;

/** the note a failed split prints is printed once per run; a test run is a run of its own. */
export function resetFfmpegWarning(): void {
  ffmpegWarned = false;
}

/**
 * the recording of one viewport, once its context has closed: the file moves next to
 * full.png and ffmpeg splits the load and, when there was one, the interaction into frames.
 * nothing here fails the unit: frames feed a report, the video is what the pack keeps.
 */
async function finishMotion(input: {
  video: Video | null;
  vdir: string;
  fps: number;
  keepFrames: boolean;
  prepareAt: number | null;
  settleAt: number;
  attached: boolean;
  resolveFfmpeg: () => Promise<string>;
}): Promise<MotionInfo> {
  if (!input.video) {
    return {
      video: null,
      fps: input.fps,
      settleAt: input.settleAt,
      segments: [],
      framesKept: false,
      note: input.attached
        ? "attached session: playwright records video per browser context, and the attached chrome's context is the user's own; nothing was recorded"
        : 'no video handle for this page',
    };
  }
  const videoFile = path.join(input.vdir, UNIT_FILES.video);
  const framesDir = path.join(input.vdir, UNIT_FILES.frames);
  // the video survives its own split: a missing ffmpeg, a truncated recording from a browser
  // that was killed, a full disk. every one of them is a lost report, not a lost unit, so the
  // reason goes into the note and the caller never sees an error from here.
  let renamed = false;
  try {
    // path() resolves once the context has closed, which release() did
    const recorded = await input.video.path();
    await fs.mkdir(input.vdir, { recursive: true });
    await fs.rename(recorded, videoFile);
    renamed = true;
    const ffmpeg = await input.resolveFfmpeg();
    // the load runs from the video's start to the moment settle began, capped at the segment
    // length: past that instant the video holds the capture's own scroll sweep, which two
    // walks of the same page never perform at the same pace
    const plan: { name: string; start: number; seconds: number }[] = [
      { name: 'load', start: 0, seconds: Math.min(MOTION.segmentSeconds, input.settleAt / 1000) },
    ];
    if (input.prepareAt !== null) {
      plan.push({
        name: 'prepare',
        start: Math.max(0, input.prepareAt - MOTION.leadIn),
        seconds: MOTION.segmentSeconds,
      });
    }
    const segments: MotionInfo['segments'] = [];
    for (const seg of plan) {
      const frames = await splitVideo({
        ffmpeg,
        video: videoFile,
        outDir: framesDir,
        segment: seg.name,
        start: seg.start,
        seconds: seg.seconds,
        fps: input.fps,
        maxFrames: MOTION.maxFramesPerSegment,
      });
      segments.push({ name: seg.name, start: seg.start, seconds: seg.seconds, frames });
    }
    if (!input.keepFrames) await fs.rm(framesDir, { recursive: true, force: true });
    return {
      video: UNIT_FILES.video,
      fps: input.fps,
      settleAt: input.settleAt,
      segments,
      framesKept: input.keepFrames,
      note: null,
    };
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    if (!ffmpegWarned) {
      console.warn(note);
      ffmpegWarned = true;
    }
    // a half-written frames dir is not frames: the note says so, and framesKept is false
    await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
    return {
      video: renamed ? UNIT_FILES.video : null,
      fps: input.fps,
      settleAt: input.settleAt,
      segments: [],
      framesKept: false,
      note,
    };
  }
}

export async function capturePageUnit(opts: {
  pack: PackPaths;
  unitId: string;
  url: string;
  viewports: Viewport[];
  session: Session;
  reachedBy?: string;
  prepare?: Prepare;
  /** record video per viewport and split it into frames; absent means no recording */
  motion?: MotionOptions;
  /** manifest.capture's rest-shot settings; absent falls back to SETTLE's */
  dynamic?: DynamicOptions;
}): Promise<CaptureSummary> {
  const unitDir = opts.pack.unitDir(opts.unitId);
  let summary: CaptureSummary | null = null;
  // a page dir holds its states under states/; a recapture of the page keeps them
  await writeDirAtomic(
    unitDir,
    async (tmp) => {
      const store = new AssetStore(opts.pack.assetsDir(tmp));
      const sheetCache = new Map<string, ParsedStylesheet>();
      const captures: ViewportCapture[] = [];
      const unreachable: string[] = [];
      for (const viewport of opts.viewports) {
        const vdir = opts.pack.viewportDir(tmp, viewport.name);
        // video is a context option: recorded from the page's creation into the unit's own
        // temp dir, finished when the context closes. an attached chrome's context is the
        // user's own and takes no options; finishMotion records that nothing was recorded
        const recording = opts.motion !== undefined && !opts.session.attached;
        // the recording starts with the page, which openPage creates: settleAt counts from here
        const openedAt = Date.now();
        const opened = await openPage(
          opts.session,
          viewport,
          recording
            ? {
                recordVideo: {
                  dir: vdir,
                  size: { width: viewport.width, height: viewport.height },
                },
              }
            : undefined,
        );
        const video = opened.page.video();
        let shot: ViewportShot | null = null;
        try {
          attachAssetCapture(opened.page, store);
          shot = await captureViewport({
            page: opened.page,
            viewport,
            url: opts.url,
            prepare: opts.prepare,
            openedAt,
            store,
            sheetCache,
            dynamic: opts.dynamic,
          });
          await store.flush();
        } catch (err) {
          // a state whose trigger is hidden at this viewport (a hover menu on a phone) is
          // captured at the viewports that can reach it; only a state reachable nowhere fails
          if ((err as Error & { code?: string }).code !== ERROR_CODES.unreachable) throw err;
          unreachable.push((err as Error).message);
          console.warn(
            `${opts.unitId}: not reachable at ${viewport.name}: ${(err as Error).message}`,
          );
        } finally {
          await opened.release();
        }
        if (!shot) {
          // nothing of this viewport is kept, its recording included
          await fs.rm(vdir, { recursive: true, force: true });
          continue;
        }
        const motion = opts.motion
          ? await finishMotion({
              video,
              vdir,
              fps: opts.motion.fps,
              keepFrames: opts.motion.keepFrames,
              prepareAt: shot.prepareAt,
              settleAt: shot.settleAt,
              attached: opts.session.attached !== null,
              resolveFfmpeg: opts.motion.resolveFfmpeg ?? resolveFfmpeg,
            })
          : null;
        captures.push({ ...shot, motion });
      }
      if (!captures.length) {
        // the reason from the first viewport travels with the error: it names the target that
        // was not there, which is what the blocked unit's question has to say
        const why = unreachable[0] ? `: ${unreachable[0]}` : '';
        throw coded(`${opts.unitId}: not reachable at any viewport${why}`, ERROR_CODES.unreachable);
      }
      const primary = captures.find((c) => c.viewport.name === 'desktop') ?? captures[0]!;
      const byName = new Map<ViewportName, ViewportCapture>(
        captures.map((c) => [c.viewport.name, c]),
      );

      // sections come from the primary viewport; bboxes per viewport are matched by stable path
      const sections: SectionsFile = primary.extract.sections.map((s) => {
        const id = sectionIdFor(s.order, s.role, s.heading);
        const bboxFor = (name: ViewportName): Rect | null => {
          const cap = byName.get(name);
          if (!cap) return null;
          // no same-order fallback: the section at the same index on the other viewport is a
          // different element often enough that a wrong crop is worse than no crop. null skips
          // the crop here and skips the viewport in verify.
          const match = cap.extract.sections.find((x) => x.path === s.path);
          if (!match) {
            console.warn(`no ${name} match for section ${id} at ${s.path}; skipping that viewport`);
            return null;
          }
          return match.bbox;
        };
        return {
          id,
          order: s.order,
          role: s.role,
          heading: s.heading,
          selector: s.selector,
          path: s.path,
          ref: s.ref,
          dataSection: s.dataSection,
          bbox: { mobile: bboxFor('mobile'), desktop: bboxFor('desktop') },
          items: s.items,
          buttons: s.buttons,
          imageCount: s.imageCount,
          svgCount: s.svgCount,
        };
      });

      const styles: StylesFile = { mobile: {}, desktop: {} };
      for (const cap of captures) {
        for (const el of cap.extract.elements) {
          styles[cap.viewport.name][el.path] = {
            ref: el.ref,
            dataRef: el.dataRef,
            tag: el.tag,
            bbox: el.bbox,
            styles: el.styles,
          };
        }
      }

      const text: TextFile = primary.extract.text;

      // keyframes and font faces: the cssom first (per sheet the page can read), then every
      // captured stylesheet body for what the page could not read, such as a cross-origin
      // sheet. a name the cssom already gave is not overwritten, and `from` records which
      // reader found it; both readers' stops are in cssom spellings (see canonicaliseKeyframes)
      const keyframes: AnimationsFile['keyframes'] = {};
      const gathered: FontFaceSource[] = [];
      const unreadable = new Set<string>();
      const parseErrors = new Map<string, number>();
      for (const cap of captures) {
        for (const [name, stops] of Object.entries(cap.cssom.keyframes)) {
          keyframes[name] = { from: 'cssom', stops };
        }
        gathered.push(...cap.cssom.fontFaces);
        for (const href of cap.cssom.unreadable) unreadable.add(href);
      }
      for (const cap of captures) {
        for (const [name, stops] of Object.entries(cap.sheets.keyframes)) {
          if (!keyframes[name]) keyframes[name] = { from: 'stylesheet', stops };
        }
        gathered.push(...cap.sheets.fontFaces);
        for (const e of cap.sheets.parseErrors) parseErrors.set(e.url, e.errors);
      }
      // a face declared once is pushed once, whatever the viewport count and whichever reader saw it
      const faces = uniqueFaces(gathered);
      // a face served as a data: url never crossed the wire: its bytes are decoded into the
      // store under the url, so mapFonts finds it like any fetched file
      let decoded = false;
      for (const face of faces) {
        for (const url of face.urls) {
          if (!/^data:/i.test(url)) continue;
          if (await store.saveInline(url, { family: face.family, weight: face.weight })) {
            decoded = true;
          }
        }
      }
      // the index was last written per viewport, before any of this was decoded into the store
      if (decoded) await store.flush();
      const elements: AnimationsFile['elements'] = { mobile: {}, desktop: {} };
      const observed: AnimationsFile['observed'] = { mobile: [], desktop: [] };
      for (const cap of captures) {
        for (const el of cap.extract.elements) {
          const entry = animationOf(el);
          if (entry) elements[cap.viewport.name][el.path] = entry;
        }
        observed[cap.viewport.name] = cap.observed;
      }
      const animations: AnimationsFile = {
        keyframes,
        elements,
        observed,
        unreadableStylesheets: [...unreadable],
      };

      // fonts: each loaded face to the file its @font-face src was fetched into. an unmatched
      // face is only a gap in the mapping; a page that loaded a web font while the store holds
      // no font file at all is a gap in the capture, and that blocks the unit.
      // only a fetched file answers the guard below: an inline face decoded into the store
      // never crossed the wire, so it says nothing about whether the fetched ones landed
      const fontFiles = store.entries.filter((e) => e.kind === 'font' && /^https?:/i.test(e.url));
      const fonts = mapFonts(primary.extract.fonts, faces, (u) => store.fileFor(u));
      // only a face fetched over http could have landed in the store, so only such a face can
      // be missing from it. a family served from a data: url or found with local() is loaded
      // without a request and would otherwise block every unit that uses one.
      const overTheWire = fonts.filter(
        (f) =>
          f.status === 'loaded' &&
          !GENERIC_FAMILIES.has(f.family.toLowerCase()) &&
          matchingFaces(f, faces).some((face) => face.urls.some((u) => /^https?:/i.test(u))),
      );
      if (overTheWire.length > 0 && fontFiles.length === 0) {
        throw coded(
          `fonts loaded by the page but not captured: ${overTheWire.map((f) => f.family).join(', ')}`,
          ERROR_CODES.fontsMissing,
        );
      }

      const meta: PageMeta = {
        url: opts.url,
        finalUrl: primary.extract.url,
        title: primary.extract.title,
        reachedBy: opts.reachedBy ?? 'goto',
        capturedAt: new Date().toISOString(),
        masks: {
          mobile: byName.get('mobile')?.masks ?? [],
          desktop: byName.get('desktop')?.masks ?? [],
        },
        fonts,
        colours: primary.extract.colours,
        trackers: primary.extract.trackers,
        failedAssets: store.failed,
        stylesheetParseErrors: [...parseErrors]
          .map(([url, errors]) => ({ url, errors }))
          .sort((a, b) => (a.url < b.url ? -1 : 1)),
        pageHeight: {
          mobile: byName.get('mobile')?.extract.pageHeight ?? 0,
          desktop: byName.get('desktop')?.extract.pageHeight ?? 0,
        },
        motion: {
          mobile: byName.get('mobile')?.motion ?? null,
          desktop: byName.get('desktop')?.motion ?? null,
        },
      };

      await writeJson(path.join(tmp, UNIT_FILES.meta), meta);
      await writeJson(path.join(tmp, UNIT_FILES.sections), sections);
      await writeJson(path.join(tmp, UNIT_FILES.text), text);
      await writeJson(path.join(tmp, UNIT_FILES.styles), styles);
      await writeJson(path.join(tmp, UNIT_FILES.animations), animations);
      await fs.writeFile(path.join(tmp, UNIT_FILES.dom), primary.extract.dom);

      for (const cap of captures) {
        const vdir = opts.pack.viewportDir(tmp, cap.viewport.name);
        await fs.mkdir(vdir, { recursive: true });
        await writePng(path.join(vdir, UNIT_FILES.full), cap.full);
        for (const s of sections) {
          const box = s.bbox[cap.viewport.name];
          if (!box) continue;
          await writePng(
            path.join(vdir, UNIT_FILES.section(s.id)),
            cropPng(cap.full, box, cap.viewport.scale),
          );
        }
      }

      // snapshot.html must be the last file written: it inlines everything above it.
      const snapshot = await buildSnapshot(primary.extract.dom, primary.extract.url, {
        fileFor: (url) => store.fileFor(url),
        readFile: (file) => fs.readFile(path.join(store.dir, file)),
        contentTypeFor: (url) => store.entries.find((e) => e.url === url)?.contentType ?? null,
      });
      await fs.writeFile(path.join(tmp, UNIT_FILES.snapshot), snapshot);

      summary = { unitDir, sections, meta };
    },
    { keep: ['states'] },
  );
  return summary!;
}
