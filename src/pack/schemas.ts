import { z } from 'zod';

export const ViewportNameSchema = z.enum(['mobile', 'desktop']);

export const ViewportSchema = z.strictObject({
  name: ViewportNameSchema,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  scale: z.number().positive(),
  mobile: z.boolean(),
});

export const RectSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Rect = z.infer<typeof RectSchema>;

/** how a replay finds an element again: role and accessible name, then visible text, then a css path. */
export const TargetSchema = z.strictObject({
  role: z.strictObject({ role: z.string(), name: z.string() }).nullable(),
  text: z.string().nullable(),
  css: z.string(),
});
export type Target = z.infer<typeof TargetSchema>;

export const ActionKindSchema = z.enum(['hover', 'click', 'input', 'change', 'keydown', 'scroll']);
export type ActionKind = z.infer<typeof ActionKindSchema>;

/**
 * one user action. `value` is what was typed or chosen, or the key for keydown; `input`
 * names a flow input that supplies the value at replay instead (a password or an email is
 * never stored); `scroll` is the window offset for a scroll action; `target` is null for scroll.
 */
export const ActionSchema = z.strictObject({
  kind: ActionKindSchema,
  target: TargetSchema.nullable(),
  value: z.string().nullable(),
  input: z.string().nullable(),
  scroll: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
});
export type Action = z.infer<typeof ActionSchema>;

/** raw field attributes reported alongside an input/change RecordedEvent, used only to
 * decide sensitivity on the node side; never persisted to a Step. */
export const RecordedFieldSchema = z.strictObject({
  type: z.string(),
  autocomplete: z.string(),
  name: z.string(),
  id: z.string(),
});
export type RecordedField = z.infer<typeof RecordedFieldSchema>;

/**
 * what the in-page recorder reports through the exposed binding for one user action, before
 * the node side turns a run of these into Steps. anything calling the binding controls this
 * shape entirely, so it is untrusted input and always validated against this schema before
 * use. `field` and `form` are transient (masking and implicit-submit scoping), never written
 * to disk.
 */
export const RecordedEventSchema = z.strictObject({
  kind: z.enum(['click', 'input', 'change', 'keydown', 'scroll']),
  target: TargetSchema.nullable(),
  value: z.string().nullable(),
  input: z.string().nullable(),
  scroll: z.strictObject({ x: z.number(), y: z.number() }).nullable(),
  field: RecordedFieldSchema.nullable(),
  form: z.number().int().nonnegative().nullable(),
});
export type RecordedEvent = z.infer<typeof RecordedEventSchema>;

/** a recorded action: 1-based position, the url after it, and when it happened. */
export const StepSchema = z.strictObject({
  ...ActionSchema.shape,
  n: z.number().int().positive(),
  url: z.string(),
  at: z.string(),
});
export type Step = z.infer<typeof StepSchema>;

/** steps/<flow>.json */
export const StepsFileSchema = z.strictObject({
  flow: z.string(),
  start: z.string().url(),
  recordedAt: z.string(),
  steps: z.array(StepSchema),
});
export type StepsFile = z.infer<typeof StepsFileSchema>;

export const UnitStatusSchema = z.enum([
  'planned',
  'captured',
  'building',
  'verifying',
  'reviewing',
  'passed',
  'blocked',
]);
export type UnitStatus = z.infer<typeof UnitStatusSchema>;

export const UnitKindSchema = z.enum(['page', 'section', 'state', 'flowStep']);

export const UnitRecordSchema = z.strictObject({
  kind: UnitKindSchema,
  status: UnitStatusSchema,
  url: z.string().optional(),
  dependsOn: z.array(z.string()),
  rounds: z.number().int().nonnegative(),
  lastScore: z.number().optional(),
  thresholdOverride: z.number().optional(),
  thresholdReason: z.string().optional(),
  blockedReason: z.string().optional(),
  question: z.string().optional(),
  /** a state unit: the ordered actions that reach it from its page's url. */
  actions: z.array(ActionSchema).optional(),
  /** a state unit: the viewports whose discovery pass reached it; absent means every viewport. */
  reachable: z.array(ViewportNameSchema).optional(),
  /**
   * a state unit: the actions per viewport when a viewport's own discovery pass reached the
   * state through a different trigger (a hamburger at mobile, a nav hover at desktop).
   * `actions` stays the first pass's, so a reader without this field still replays something.
   */
  actionsByViewport: z
    .strictObject({
      mobile: z.array(ActionSchema).optional(),
      desktop: z.array(ActionSchema).optional(),
    })
    .optional(),
  /** a blocked unit: the artefacts a reader needs (verify.json, diff and sheet pngs, the brief), absolute paths */
  artefacts: z.array(z.string()).optional(),
  /** the orchestrator: where the last finished round logged, relative to the pack root; the next brief reads its verify.json and reviewer notes */
  lastRoundDir: z.string().optional(),
  updatedAt: z.string(),
});
export type UnitRecord = z.infer<typeof UnitRecordSchema>;

export const QuestionSchema = z.strictObject({
  id: z.string(),
  unit: z.string().optional(),
  text: z.string(),
  answer: z.string().optional(),
  answeredAt: z.string().optional(),
});

export const ManifestSchema = z.strictObject({
  host: z.string(),
  sourceUrl: z.string().url(),
  createdAt: z.string(),
  toolVersion: z.string(),
  viewports: z.strictObject({ mobile: ViewportSchema, desktop: ViewportSchema }),
  capture: z.strictObject({
    attach: z.boolean(),
    profile: z.boolean(),
    fps: z.number().int().positive(),
    crawlDepth: z.number().int().nonnegative(),
    scope: z.array(z.string()),
    /**
     * rest shots taken when looking for regions that change on their own, and the ms between
     * them. the defaults (SETTLE) span three seconds; a carousel on a five-second timer needs
     * a wider span, and raising them here is how a pack says so.
     */
    /** at least two: one shot has nothing to differ from */
    dynamicShots: z.number().int().min(2),
    dynamicGap: z.number().int().nonnegative(),
  }),
  units: z.record(z.string(), UnitRecordSchema),
  questions: z.array(QuestionSchema),
  flows: z.record(
    z.string(),
    z.strictObject({
      steps: z.array(z.string()),
      inputs: z.record(z.string(), z.string().nullable()),
    }),
  ),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const FontSchema = z.strictObject({
  family: z.string(),
  weight: z.string(),
  style: z.string(),
  status: z.string(),
  /** the captured file under assets/, found through @font-face; null when no face maps it */
  file: z.string().nullable(),
  /** the @font-face src url the file was fetched from */
  url: z.string().nullable(),
});

export const MotionSegmentSchema = z.strictObject({
  /** `load`, or `prepare` for the interaction that reaches a state or a flow step */
  name: z.string(),
  /** seconds into the video where the segment starts */
  start: z.number(),
  /** seconds of video it covers, so the segment says where it ends as well as where it starts */
  seconds: z.number(),
  /** frames written for it; they are on disk only when framesKept */
  frames: z.number().int().nonnegative(),
});
export const MotionInfoSchema = z.strictObject({
  /** `video.webm` next to full.png, or null when nothing was recorded (see note) */
  video: z.string().nullable(),
  fps: z.number().int().positive(),
  /**
   * ms from the page's creation (openPage is called at that instant, and the recording starts
   * with the page) to the moment settle began: the load is over by then, and everything after
   * it is the capture's own scroll sweep. null when the viewport was never reached far enough
   * to settle.
   */
  settleAt: z.number().nullable(),
  segments: z.array(MotionSegmentSchema),
  framesKept: z.boolean(),
  note: z.string().nullable(),
});
export type MotionInfo = z.infer<typeof MotionInfoSchema>;

export const PageMetaSchema = z.strictObject({
  url: z.string(),
  finalUrl: z.string(),
  title: z.string(),
  reachedBy: z.string(),
  capturedAt: z.string(),
  masks: z.strictObject({ mobile: z.array(RectSchema), desktop: z.array(RectSchema) }),
  fonts: z.array(FontSchema),
  colours: z.array(z.string()),
  trackers: z.array(z.string()),
  failedAssets: z.array(z.strictObject({ url: z.string(), reason: z.string() })),
  /** per captured stylesheet, how many rules css-tree could not parse; 0 entries are not listed */
  stylesheetParseErrors: z.array(
    z.strictObject({ url: z.string(), errors: z.number().int().nonnegative() }),
  ),
  pageHeight: z.strictObject({ mobile: z.number(), desktop: z.number() }),
  /** null for a viewport that was not captured */
  motion: z.strictObject({
    mobile: MotionInfoSchema.nullable(),
    desktop: MotionInfoSchema.nullable(),
  }),
});
export type PageMeta = z.infer<typeof PageMetaSchema>;

export const SectionItemSchema = z.strictObject({
  title: z.string(),
  description: z.string(),
  path: z.string(),
});

export const SectionSchema = z.strictObject({
  id: z.string(),
  order: z.number().int(),
  role: z.string(),
  heading: z.string(),
  selector: z.string(),
  path: z.string(),
  ref: z.string(),
  dataSection: z.string().nullable(),
  bbox: z.strictObject({ mobile: RectSchema.nullable(), desktop: RectSchema.nullable() }),
  items: z.array(SectionItemSchema),
  buttons: z.array(z.string()),
  imageCount: z.number().int(),
  svgCount: z.number().int(),
});
export type Section = z.infer<typeof SectionSchema>;
export const SectionsFileSchema = z.array(SectionSchema);
export type SectionsFile = z.infer<typeof SectionsFileSchema>;

export const TextBlockSchema = z.strictObject({
  tag: z.string(),
  text: z.string(),
  y: z.number(),
  path: z.string(),
});
export const TextFileSchema = z.array(TextBlockSchema);
export type TextFile = z.infer<typeof TextFileSchema>;

export const ElementStylesSchema = z.strictObject({
  ref: z.string(),
  dataRef: z.string().nullable(),
  tag: z.string(),
  bbox: RectSchema,
  styles: z.record(z.string(), z.string()),
});
export type ElementStyles = z.infer<typeof ElementStylesSchema>;
/** keyed by stable path; one map per viewport. */
export const StylesFileSchema = z.strictObject({
  mobile: z.record(z.string(), ElementStylesSchema),
  desktop: z.record(z.string(), ElementStylesSchema),
});
export type StylesFile = z.infer<typeof StylesFileSchema>;

export const AssetEntrySchema = z.strictObject({
  url: z.string(),
  file: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  kind: z.enum(['image', 'svg', 'font', 'stylesheet', 'other']),
});
export const AssetIndexSchema = z.array(AssetEntrySchema);
export type AssetIndex = z.infer<typeof AssetIndexSchema>;

export const FrameReportSchema = z.strictObject({
  viewport: ViewportNameSchema,
  segment: z.string(),
  compared: z.number().int().nonnegative(),
  meanScore: z.number(),
  maxScore: z.number(),
  /** 1-based index of the frame with the highest score */
  worstFrame: z.number().int().nonnegative(),
  /** the side-by-side strip, null when nothing was compared */
  strip: z.string().nullable(),
  /** why nothing was compared, when `compared` is 0; null otherwise */
  note: z.string().nullable(),
});
export type FrameReport = z.infer<typeof FrameReportSchema>;

export const PixelScoreSchema = z.strictObject({
  score: z.number(),
  mismatched: z.number().int(),
  // the pixels compared: the whole shot for a page, and for a section crop the crop minus its
  // outer one-pixel ring (a fractional css edge blends with the neighbour, so the ring is not
  // compared); score is mismatched over this number
  total: z.number().int(),
  diffPng: z.string(),
  contactSheet: z.string(),
});
export const VerifyResultSchema = z.strictObject({
  unitId: z.string(),
  target: z.string(),
  verdict: z.enum(['pass', 'fail']),
  gate: z.number(),
  pixel: z.strictObject({
    mobile: PixelScoreSchema.nullable(),
    desktop: PixelScoreSchema.nullable(),
  }),
  heightDelta: z.strictObject({ mobile: z.number().nullable(), desktop: z.number().nullable() }),
  styles: z.array(
    z.strictObject({
      path: z.string(),
      ref: z.string(),
      viewport: z.enum(['mobile', 'desktop']),
      property: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  ),
  structure: z.array(
    z.strictObject({
      kind: z.enum(['heading', 'item', 'button', 'count', 'text']),
      expected: z.string(),
      actual: z.string(),
      where: z.string(),
    }),
  ),
  animations: z.array(
    z.strictObject({
      path: z.string(),
      ref: z.string(),
      viewport: ViewportNameSchema,
      /** a longhand (`animation-duration`), `keyframes:<name>`, or `observed:<type>` */
      property: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  ),
  /** the motion report, never gating: one entry per viewport and segment compared */
  frames: z.array(FrameReportSchema),
  missing: z.array(z.string()),
  artefacts: z.array(z.string()),
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

export const KeyframeStopSchema = z.strictObject({
  /** as the cssom reports it: `0%`, `50%`, `100%` */
  offset: z.string(),
  declarations: z.record(z.string(), z.string()),
});
export type KeyframeStop = z.infer<typeof KeyframeStopSchema>;

/** one @keyframes rule. `from` names the reader, because the cssom and a parsed body format values differently. */
export const KeyframesSchema = z.strictObject({
  from: z.enum(['cssom', 'stylesheet']),
  stops: z.array(KeyframeStopSchema),
});

export const ElementAnimationSchema = z.strictObject({
  ref: z.string(),
  dataRef: z.string().nullable(),
  /** the computed animation-* longhands; null when animation-name is none */
  animation: z.record(z.string(), z.string()).nullable(),
  /** the computed transition-* longhands; null when every transition-duration is 0s */
  transition: z.record(z.string(), z.string()).nullable(),
});
export type ElementAnimation = z.infer<typeof ElementAnimationSchema>;

/** an animation chromium reported over cdp while the unit was captured. */
export const ObservedAnimationSchema = z.strictObject({
  id: z.string(),
  type: z.enum(['CSSAnimation', 'CSSTransition', 'WebAnimation']),
  /** the keyframes name, the transitioned property, or empty for a waapi animation */
  name: z.string(),
  path: z.string().nullable(),
  ref: z.string().nullable(),
  /** the element's own `data-ref`, when it carries one: how a rebuild is matched to it */
  dataRef: z.string().nullable(),
  duration: z.number(),
  delay: z.number(),
  /** null is infinite */
  iterations: z.number().nullable(),
  easing: z.string(),
  keyframeEasings: z.array(z.string()),
  /** `load`, `prepare` or `settle`: what the page was doing when it started */
  phase: z.string(),
  /** ms after the observer started */
  startedAt: z.number(),
});
export type ObservedAnimation = z.infer<typeof ObservedAnimationSchema>;

/** animations.json: keyframes once, elements and observed animations per viewport. */
export const AnimationsFileSchema = z.strictObject({
  keyframes: z.record(z.string(), KeyframesSchema),
  elements: z.strictObject({
    mobile: z.record(z.string(), ElementAnimationSchema),
    desktop: z.record(z.string(), ElementAnimationSchema),
  }),
  observed: z.strictObject({
    mobile: z.array(ObservedAnimationSchema),
    desktop: z.array(ObservedAnimationSchema),
  }),
  /** stylesheet urls the page could not read (cross-origin); their rules come from the captured bodies */
  unreadableStylesheets: z.array(z.string()),
});
export type AnimationsFile = z.infer<typeof AnimationsFileSchema>;

/**
 * what a builder worker reports when it stops; anything else is malformed_output. the
 * orchestrator logs it and never reads it as success.
 */
export const WorkerOutputSchema = z.strictObject({
  summary: z.string(),
  filesTouched: z.array(z.string()),
  notes: z.string(),
});
export type WorkerOutput = z.infer<typeof WorkerOutputSchema>;

export const ReviewerOutputSchema = z.strictObject({
  verdict: z.enum(['pass', 'reject']),
  reasons: z.array(z.string()),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutputSchema>;

/** what an explorer worker answers; the states and flows it found come from its browser's journal, never from here */
export const ExplorerOutputSchema = z.strictObject({
  summary: z.string(),
  questions: z.array(z.string()),
});
export type ExplorerOutput = z.infer<typeof ExplorerOutputSchema>;

export const WorkerRoleSchema = z.enum(['builder', 'reviewer', 'explorer']);
export type WorkerRole = z.infer<typeof WorkerRoleSchema>;

export const WorkerOutcomeSchema = z.enum([
  'done',
  'rate_limited',
  'malformed_output',
  'crashed',
  'turns_exhausted',
  'timeout',
]);
export type WorkerOutcome = z.infer<typeof WorkerOutcomeSchema>;

/**
 * the one object `claude -p --output-format json` prints (the agent sdk's SDKResultMessage).
 * loose: the binary adds fields between releases, and the runner reads these only.
 */
export const ClaudeResultSchema = z.looseObject({
  type: z.literal('result'),
  subtype: z.string(),
  is_error: z.boolean(),
  num_turns: z.number().int().optional(),
  result: z.string().optional(),
  errors: z.array(z.string()).optional(),
  /** the http status of the api error that ended the run; 429 is a quota rejection */
  api_error_status: z.number().nullable().optional(),
  terminal_reason: z.string().optional(),
  /** why the model's last turn ended (`end_turn`, `max_tokens`); on 2.1.278's result, logged and never read */
  stop_reason: z.string().nullable().optional(),
  session_id: z.string().optional(),
  total_cost_usd: z.number().optional(),
  structured_output: z.unknown().optional(),
  permission_denials: z.array(z.unknown()).optional(),
});
export type ClaudeResult = z.infer<typeof ClaudeResultSchema>;

/** round-N/<role>.json: what the runner kept of one claude -p call */
export const WorkerRunSchema = z.strictObject({
  role: WorkerRoleSchema,
  outcome: WorkerOutcomeSchema,
  /** why it was classified so; null when done */
  reason: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  numTurns: z.number().int().nullable(),
  sessionId: z.string().nullable(),
  costUsd: z.number().nullable(),
  /** claude's `stop_reason` on the result object, when it printed one */
  stopReason: z.string().nullable(),
  startedAt: z.string(),
  durationMs: z.number(),
  /** the parsed output when done: a builder's, a reviewer's or an explorer's */
  output: z.union([WorkerOutputSchema, ReviewerOutputSchema, ExplorerOutputSchema]).nullable(),
  /** file names next to this record: the brief that went in, the raw stdout and stderr */
  files: z.strictObject({ brief: z.string(), stdout: z.string(), stderr: z.string() }),
});
export type WorkerRun = z.infer<typeof WorkerRunSchema>;

export const RoundResultSchema = z.enum(['passed', 'retry', 'blocked', 'interrupted']);
/** round-N/round.json, also appended to runs/<run>/run.json */
export const RoundRecordSchema = z.strictObject({
  unitId: z.string(),
  round: z.number().int().positive(),
  /** relative to the pack root */
  dir: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  builder: WorkerRunSchema.nullable(),
  checks: z.array(
    z.strictObject({ name: z.string(), exitCode: z.number().int().nullable(), ok: z.boolean() }),
  ),
  verify: z
    .strictObject({
      verdict: z.enum(['pass', 'fail']),
      score: z.number().nullable(),
      file: z.string(),
    })
    .nullable(),
  reviewer: WorkerRunSchema.nullable(),
  waits: z.array(z.strictObject({ at: z.string(), ms: z.number(), why: z.string() })),
  result: RoundResultSchema,
  /** a failed round's reason in one line, for the next brief and the report */
  reason: z.string().nullable(),
});
export type RoundRecord = z.infer<typeof RoundRecordSchema>;

/** runs/<run>/run.json */
export const RunLogSchema = z.strictObject({
  run: z.string(),
  root: z.string(),
  project: z.string(),
  target: z.string(),
  claude: z.string(),
  options: z.strictObject({
    parallel: z.number().int().positive(),
    rounds: z.number().int().positive(),
    threshold: z.number().nullable(),
  }),
  /** the model alias each role was started with; absent when the binary's own default was used */
  models: z
    .strictObject({ builder: z.string().nullable(), reviewer: z.string().nullable() })
    .optional(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  /** units whose in-flight status was reset to captured when this run restored the manifest */
  restored: z.array(z.string()),
  rounds: z.array(RoundRecordSchema),
});
export type RunLog = z.infer<typeof RunLogSchema>;

/** runs/.lock */
export const LockFileSchema = z.strictObject({
  pid: z.number().int().positive(),
  run: z.string(),
  startedAt: z.string(),
});
export type LockFile = z.infer<typeof LockFileSchema>;

/** the settings file handed to a worker with --settings: the hooks reference's shape */
export const HookCommandSchema = z.strictObject({
  type: z.literal('command'),
  command: z.string(),
  /** seconds */
  timeout: z.number().int().positive().optional(),
});
export const HookGroupSchema = z.strictObject({
  matcher: z.string().optional(),
  hooks: z.array(HookCommandSchema),
});
export const HookSettingsSchema = z.strictObject({
  hooks: z.strictObject({
    PreToolUse: z.array(HookGroupSchema).optional(),
    Stop: z.array(HookGroupSchema).optional(),
  }),
});
export type HookSettings = z.infer<typeof HookSettingsSchema>;

/** what claude pipes to a hook command on stdin; loose, the hooks read a few fields */
export const HookInputSchema = z.looseObject({
  hook_event_name: z.string(),
  cwd: z.string().optional(),
  session_id: z.string().optional(),
  stop_hook_active: z.boolean().optional(),
  tool_name: z.string().optional(),
  tool_input: z
    .looseObject({ file_path: z.string().optional(), notebook_path: z.string().optional() })
    .optional(),
});
export type HookInput = z.infer<typeof HookInputSchema>;

/** round-N/allowed-files.json: absolute files, and dir prefixes ending in a slash, an edit may touch */
export const AllowedFilesSchema = z.array(z.string());

/** round-N/stop-hook.json: how often the Stop hook has held the worker in this round */
export const StopHookStateSchema = z.strictObject({
  blocks: z.number().int().nonnegative(),
  lastVerdict: z.enum(['pass', 'fail']).nullable(),
});
export type StopHookState = z.infer<typeof StopHookStateSchema>;

/** test/helpers/fake-claude: one scripted answer */
export const ScenarioCallSchema = z.strictObject({
  when: z.strictObject({
    role: WorkerRoleSchema.optional(),
    unit: z.string().optional(),
    round: z.number().int().positive().optional(),
  }),
  /** how many calls this entry answers; 1 when absent */
  times: z.number().int().positive().optional(),
  do: z.strictObject({
    /** files written under the cwd before the result, relative path to contents; each goes through the settings file's PreToolUse hooks */
    writeFiles: z.record(z.string(), z.string()).optional(),
    /** printed as structured_output and, serialised, as the result text */
    output: z.unknown().optional(),
    /** the result text when there is no structured output (a malformed worker) */
    resultText: z.string().optional(),
    /** the result subtype; success when absent */
    subtype: z.string().optional(),
    exitCode: z.number().int().optional(),
    /** raw stdout in place of the json result */
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    sleepMs: z.number().int().nonnegative().optional(),
    /** spawn `sleep 60` with this process's own stdout and stderr before sleeping: a grandchild holding the runner's pipes, the way claude's Bash tool leaves one */
    holdPipes: z.boolean().optional(),
    /** print a rejected subscription window: is_error, api_error_status 429, the limit line on stderr, exit 1 */
    rateLimit: z.boolean().optional(),
    /** run the settings file's hooks; true when absent */
    honourHooks: z.boolean().optional(),
  }),
});
export type ScenarioCall = z.infer<typeof ScenarioCallSchema>;
export const ScenarioSchema = z.strictObject({ calls: z.array(ScenarioCallSchema) });
export type Scenario = z.infer<typeof ScenarioSchema>;

/** <scenario>.state.json: which entries were used, and every call the fake answered */
export const ScenarioStateSchema = z.strictObject({
  uses: z.array(z.number().int().nonnegative()),
  calls: z.array(
    z.strictObject({
      /** the scenario entry that answered, null when none matched */
      index: z.number().int().nullable(),
      role: z.string().nullable(),
      unit: z.string().nullable(),
      round: z.number().int().nullable(),
      cwd: z.string(),
      argv: z.array(z.string()),
      /**
       * the `SITE_*` variables this call was given: the session dir and the owner a worker's
       * own `site browser` commands read, and the scenario this fake answered from. the rest of
       * the environment is the machine's and is not a test's business.
       */
      env: z.record(z.string(), z.string()),
      startedAt: z.string(),
      endedAt: z.string(),
      /** files a PreToolUse hook denied */
      denied: z.array(z.string()),
      /** how many times the Stop hook held this call */
      stopBlocks: z.number().int().nonnegative(),
    }),
  ),
});
export type ScenarioState = z.infer<typeof ScenarioStateSchema>;

/**
 * <session>/browser.json: the keeper `site browser open` started, while it runs. the token is
 * what a command has to carry to be acted on, so the file is written for this user only: the
 * keeper's port is reachable from any process on the machine, the page it drives included.
 */
export const BrowserSessionSchema = z.strictObject({
  endpoint: z.string().url(),
  pid: z.number().int().positive(),
  /**
   * the process this session belongs to: the orchestrator running `exploreAgent`, or the shell
   * that ran `site browser open` by hand. the keeper polls it beside its idle poll and stops
   * when it is gone, so a SIGKILL of the run does not leave a chromium up for 20 minutes. it is
   * never the keeper's own parent: `site browser open` exits as soon as the browser is up.
   */
  ownerPid: z.number().int().positive(),
  startedAt: z.string(),
  url: z.string(),
  viewport: ViewportNameSchema,
  /** 32 random bytes, hex; a request without it is refused before its body is read */
  token: z.string().min(1),
});
export type BrowserSession = z.infer<typeof BrowserSessionSchema>;

/** <session>/allow.json: the hosts this session may open, set when the session is opened */
export const AllowHostsSchema = z.array(z.string());

/** <session>/journal.json: every action since the last open, as steps, each with the url it left the page on */
export const JournalSchema = z.strictObject({
  url: z.string(),
  viewport: ViewportNameSchema,
  steps: z.array(StepSchema),
  /** the opens this session refused (another host, another scheme), so a reader sees what was tried */
  refusals: z.array(z.strictObject({ url: z.string(), reason: z.string(), at: z.string() })),
});
export type Journal = z.infer<typeof JournalSchema>;

/** <session>/candidates.json: what the explorer marked with `state` and `flow`, from the journal */
export const CandidatesSchema = z.strictObject({
  states: z.array(
    z.strictObject({
      url: z.string(),
      name: z.string(),
      viewport: ViewportNameSchema,
      actions: z.array(ActionSchema),
    }),
  ),
  flows: z.array(
    z.strictObject({
      name: z.string(),
      start: z.string(),
      steps: z.array(StepSchema),
      inputs: z.array(z.string()),
    }),
  ),
});
export type Candidates = z.infer<typeof CandidatesSchema>;

/** what `site browser` posts to the keeper: one command per call */
export const DriverCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('snapshot') }),
  z.strictObject({ kind: z.literal('act'), action: ActionSchema }),
  z.strictObject({ kind: z.literal('close') }),
]);
export type DriverCommand = z.infer<typeof DriverCommandSchema>;

/** what the keeper answers: the page after the command, a note (a refused fill), or the error */
export const DriverReplySchema = z.strictObject({
  ok: z.boolean(),
  snapshot: z.string(),
  note: z.string().nullable(),
  error: z.string().nullable(),
});
export type DriverReply = z.infer<typeof DriverReplySchema>;

/** one face of a brand family: the file relative to brand.json's own dir, copied under src/assets/fonts/ by its basename */
export const BrandFaceSchema = z.strictObject({
  file: z.string().min(1),
  /** css font-weight as the @font-face rule should say it: `400`, `700`, `100 900` */
  weight: z.string().min(1),
  style: z.string().min(1),
});
export type BrandFace = z.infer<typeof BrandFaceSchema>;

/** a brand family in place of a source family: the name the theme token and the @font-face rules take, and its faces */
export const BrandFontSchema = z.strictObject({
  family: z.string().min(1),
  faces: z.array(BrandFaceSchema).min(1),
});
export type BrandFont = z.infer<typeof BrandFontSchema>;

/** a theme colour token as tokensFrom names it: `pack-<hex>` or `pack-<hex>-<alpha percent>` */
export const COLOUR_TOKEN = /^pack-[0-9a-f]{6}(-\d{1,3})?$/;
/** a channel of an rgb call: a number, whole or not, with an optional percent */
const RGB_CHANNEL = String.raw`\d{1,3}(?:\.\d+)?%?`;
/** an alpha: nought to one, or a percent */
const RGB_ALPHA = String.raw`0(?:\.\d+)?|1(?:\.0+)?|\.\d+|\d{1,3}%`;
/**
 * a css colour literal: hex in the four lengths, an rgb or rgba call whose body is three
 * channels and an optional alpha (the shape `tokensFrom` writes and `sourceColourOf` reads
 * back), or an hsl or hsla call, whose body carries units this file has no reason to spell.
 */
export const COLOUR_VALUE = new RegExp(
  `^(?:#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})` +
    `|rgba?\\(\\s*${RGB_CHANNEL}\\s*,\\s*${RGB_CHANNEL}\\s*,\\s*${RGB_CHANNEL}\\s*(?:,\\s*(?:${RGB_ALPHA})\\s*)?\\)` +
    `|hsla?\\(.+\\))$`,
  'i',
);

/**
 * every string the brand writes into the project, with the field it came from: a name's
 * replacement, a family, a colour value. the brand is inverted for the structure gate
 * (`unbrand`), so these are the keys of that inverted table and no two of them may differ
 * only by case. the shape is loose because a refinement runs on values the object parse has
 * already found fault with.
 */
function brandSideStrings(b: {
  names?: Record<string, string>;
  colors?: Record<string, string>;
  fonts?: Record<string, { family?: string }>;
}): { where: string; value: string }[] {
  const out: { where: string; value: string }[] = [];
  for (const value of Object.values(b.names ?? {}))
    if (typeof value === 'string') out.push({ where: 'names', value });
  for (const font of Object.values(b.fonts ?? {}))
    if (typeof font?.family === 'string') out.push({ where: 'fonts', value: font.family });
  for (const value of Object.values(b.colors ?? {}))
    if (typeof value === 'string') out.push({ where: 'colors', value });
  return out;
}

/** a word character the way the codemod's boundary reads one: a letter, a digit, a combining mark or an underscore */
const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;

/**
 * `word` stands in `value` as a whole word, in any of the three case forms the codemod
 * replaces (as written, all lower, all upper): the test `substitute` would apply, without
 * importing it (the pack knows nothing of verify).
 */
function carriesWord(value: string, word: string): boolean {
  for (const form of new Set([word, word.toLowerCase(), word.toUpperCase()])) {
    for (let at = value.indexOf(form); at !== -1; at = value.indexOf(form, at + 1)) {
      const before = at === 0 ? '' : value[at - 1]!;
      const after = value[at + form.length] ?? '';
      if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)) return true;
    }
  }
  return false;
}

/**
 * brand.json (spec section 7, phase two): what `site brand` lays over a rebuilt project. every
 * field is present, `{}` when it has nothing to say, the way every other file here is strict.
 * - names: source string to brand string, matched as whole words; the match's case (as written,
 *   all lower, all upper) picks the replacement's case, and any other casing is left alone.
 * - logos: an asset under src/assets/ (its file name, or the source's basename when only one
 *   asset ends in it) to the replacement file, relative to brand.json; the format stays.
 * - colors: a theme colour token to its new value; the token keeps its name, so no component
 *   changes and the classes derived from the pack keep working.
 * - fonts: a source family (as meta.fonts names it) to the brand family and its faces; the
 *   family's theme token keeps its key and takes the brand family as its value.
 */
export const BrandSchema = z
  .strictObject({
    names: z.record(z.string().min(1), z.string().min(1)),
    logos: z.record(z.string().min(1), z.string().min(1)),
    colors: z.record(z.string().regex(COLOUR_TOKEN), z.string().regex(COLOUR_VALUE)),
    fonts: z.record(z.string().min(1), BrandFontSchema),
  })
  .refine(
    (b) =>
      new Set(Object.keys(b.names ?? {}).map((k) => k.toLowerCase())).size ===
      Object.keys(b.names ?? {}).length,
    {
      message: 'two names differ only by case, and the match is case-insensitive',
      path: ['names'],
    },
  )
  // the same rule on the other side of the arrow, across all three fields at once: the gate
  // inverts the brand into one table keyed by the brand string, so `Acme` and `ACME` would
  // collide there and one of the two sources would be dropped without a word. two fields
  // saying the same string the same way is allowed and documented (the first source wins).
  .superRefine((b, ctx) => {
    const seen = new Map<string, string>();
    for (const { where, value } of brandSideStrings(b)) {
      const first = seen.get(value.toLowerCase());
      if (first === undefined) seen.set(value.toLowerCase(), value);
      else if (first !== value)
        ctx.addIssue({
          code: 'custom',
          message: `two brand strings differ only by case: "${first}" and "${value}", and the match is case-insensitive`,
          path: [where],
        });
    }
  })
  // the codemod re-reads the files it wrote, so a brand string that carries a source name as a
  // whole word is branded again on the next run: `Scanner -> Acme Scanner` grows a word a run,
  // and `A -> B` beside `B -> C` flips. both break the phase's promise that a second run
  // changes no bytes, so they are a bad brand rather than a surprise on disk.
  .superRefine((b, ctx) => {
    const names = b.names ?? {};
    for (const [source, value] of Object.entries(names)) {
      if (typeof value !== 'string') continue;
      for (const key of Object.keys(names)) {
        if (!carriesWord(value, key)) continue;
        const same = value.toLowerCase() === key.toLowerCase();
        ctx.addIssue({
          code: 'custom',
          message: `${source} is branded "${value}", which ${
            same ? 'is' : 'carries'
          } the source name ${key}${same ? '' : ' as a word'}, and a second run would brand it again`,
          path: ['names'],
        });
      }
    }
  });
export type Brand = z.infer<typeof BrandSchema>;
