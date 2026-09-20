export type ViewportName = 'mobile' | 'desktop';

export interface Viewport {
  name: ViewportName;
  width: number;
  height: number;
  scale: number;
  mobile: boolean;
}

export const DEFAULT_VIEWPORTS: Record<ViewportName, Viewport> = {
  mobile: { name: 'mobile', width: 390, height: 844, scale: 3, mobile: true },
  desktop: { name: 'desktop', width: 1440, height: 900, scale: 2, mobile: false },
};

export const VIEWPORT_NAMES: ViewportName[] = ['mobile', 'desktop'];

/** mismatched-pixel fraction above which a section fails. */
export const DEFAULT_PIXEL_GATE = 0.001;
/** pixelmatch per-pixel colour threshold. */
export const PIXELMATCH_THRESHOLD = 0.1;
/** settle timings, ms. */
export const SETTLE = {
  scrollStep: 900,
  scrollPause: 150,
  afterScroll: 500,
  dynamicGap: 1500,
  /** rest shots taken dynamicGap apart; three catch a timer that ticks slower than one gap */
  dynamicShots: 3,
};
/** cell size in css px for dynamic-region detection. */
export const MASK_CELL = 16;
/** css px added on every side of a live element's box when it becomes a mask: glyph ink can overhang the box. */
export const MASK_PAD = 2;
/** changed pixels sampled per dirty region when asking the page which element is painted under them. */
export const MASK_SAMPLE = 16;
/**
 * how many times a dirty region's own area an element's box may be and still be taken as the
 * owner of that change. the topmost element over a changed pixel is often a modal backdrop or
 * a transparent fixed wrapper, which would mask the whole viewport; anything that much larger
 * than the change is passed over for the next element down the stack.
 */
export const MASK_OWNER_MAX_RATIO = 16;
/**
 * a dynamic hint (a video, a canvas, an opaque iframe, a carousel) larger than this many
 * viewports is not a hint: a `.carousel` class on a page wrapper would mask the whole page,
 * the same shape as the overlay that MASK_OWNER_MAX_RATIO passes over.
 */
export const MASK_HINT_MAX_VIEWPORTS = 1.5;
/** motion: how much video becomes frames, and how frames are compared and shown. */
export const MOTION = {
  /** seconds of video split into frames per segment (the load, and the interaction) */
  segmentSeconds: 3,
  /** seconds before the interaction's start its segment begins, so the first frame is the rest state */
  leadIn: 0.25,
  /** frames kept per segment, whatever the fps */
  maxFramesPerSegment: 90,
  /** pixelmatch per-pixel threshold for frame diffs: looser than the still gate, video is lossy */
  frameThreshold: 0.3,
  /** frames shown in a side-by-side strip, evenly spaced over the segment */
  stripFrames: 6,
  /** width of one strip panel, px */
  stripPanelWidth: 320,
};
/** the whole-page contact sheet is scaled so one panel is at most this wide; section sheets stay full size. */
export const PAGE_SHEET_PANEL_WIDTH = 720;

/**
 * state discovery: pause after a trigger, pause after a reset, pause after scrolling a
 * trigger into view (so the baseline is taken once the page has stopped moving), cap on
 * triggers tried per page.
 */
export const STATE = { afterAction: 400, afterReset: 300, settleAfterScroll: 150, maxTriggers: 40 };
/** replay: timeout per playwright action, pause after each action, ms. */
export const REPLAY = { actionTimeout: 10_000, afterAction: 300 };
/**
 * recording: scroll debounce; how long after an action a navigation still belongs to it; how
 * long after an Enter keydown its own form's implicit-submission echo (the synthetic change
 * and click chromium fires at the default submit button) is dropped rather than recorded as
 * a step, ms; how long a replay waits for a navigation the recording says that step made.
 */
export const RECORD = {
  scrollDebounce: 250,
  navigationWindow: 2_000,
  implicitSubmitWindow: 100,
  navigationTimeout: 15_000,
};
/** codes carried as `err.code` on thrown errors and as `blockedReason` on a unit, so callers branch on a value, not a message. */
export const ERROR_CODES = {
  blockedBySite: 'blocked_by_site',
  unreachable: 'unreachable',
  needsInput: 'needs_input',
  httpError: 'http_error',
  navigationFailed: 'navigation_failed',
  fontsMissing: 'fonts_missing',
  /** the orchestrator: a unit whose dependency blocked */
  dependency: 'dependency',
  /** the orchestrator: the round budget ran out without a pass */
  roundsExhausted: 'rounds_exhausted',
} as const;

/**
 * every code above is about one unit: the unit is blocked with a question and the run goes
 * on. an error with no code, or a code from nowhere, is a bug and stops the run.
 */
export const PER_UNIT_ERROR_CODES: readonly string[] = Object.values(ERROR_CODES);

/**
 * the browser a worker drives through `site browser`: how long the keeper waits for its next
 * command before it closes on its own, how often it looks, how long open and close wait for
 * it, and how many elements a snapshot lists, ms.
 */
export const DRIVER = {
  idleMs: 20 * 60_000,
  pollMs: 5_000,
  openTimeoutMs: 60_000,
  closeGraceMs: 10_000,
  /** how long a keeper may take to go after SIGKILL before the close gives up and says so, ms */
  killGraceMs: 2_000,
  /**
   * how old a session file may be and still have its pid signalled. a pid is reused, so a file
   * a killed run left days ago may name somebody else's process by now; one that old is ignored
   * rather than signalled, unless the keeper answered this session's token a moment ago.
   */
  staleMs: 24 * 60 * 60_000,
  snapshotMax: 80,
};
