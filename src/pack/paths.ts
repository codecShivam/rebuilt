import path from 'node:path';
import type { ViewportName } from './defaults';
import { parseUnitId } from './ids';

/** a unit id as a file name: `page:index#s02-hero` becomes `page_index_s02-hero`. */
export function safeUnitName(unitId: string): string {
  return unitId.replace(/[:#/]/g, '_');
}

export class PackPaths {
  constructor(readonly root: string) {}
  get manifest() {
    return path.join(this.root, 'manifest.json');
  }
  get profileDir() {
    return path.join(this.root, 'profile');
  }
  get stepsDir() {
    return path.join(this.root, 'steps');
  }
  stepsFile(flow: string) {
    return path.join(this.stepsDir, `${flow}.json`);
  }
  pageDir(slug: string) {
    return path.join(this.root, 'pages', slug);
  }
  stateDir(slug: string, state: string) {
    return path.join(this.pageDir(slug), 'states', state);
  }
  flowStepDir(flow: string, step: string) {
    return path.join(this.root, 'flows', flow, step);
  }
  /** the directory holding a unit's artefacts. a section unit resolves to its page dir. */
  unitDir(unitId: string) {
    const p = parseUnitId(unitId);
    switch (p.kind) {
      case 'page':
      case 'section':
        return this.pageDir(p.slug);
      case 'state':
        return this.stateDir(p.slug, p.state);
      case 'flowStep':
        return this.flowStepDir(p.flow, p.step);
    }
  }
  viewportDir(unitDir: string, viewport: ViewportName) {
    return path.join(unitDir, viewport);
  }
  assetsDir(unitDir: string) {
    return path.join(unitDir, 'assets');
  }
  /** orchestrator runs, `site verify`'s own output, and the lock */
  get runsDir() {
    return path.join(this.root, 'runs');
  }
  get lock() {
    return path.join(this.runsDir, '.lock');
  }
}

/**
 * the dev server's own files in a run dir. the pid file sits beside the log, so a later run
 * can signal the group a killed run left holding the port.
 */
export const DEV_SERVER_FILES = { log: 'dev-server.log', pid: 'dev-server.pid' } as const;

/** one orchestrator run: runs/<run>/ with a unit dir and a round dir per round. */
export class RunPaths {
  constructor(
    readonly root: string,
    readonly run: string,
  ) {}
  get dir() {
    return path.join(this.root, 'runs', this.run);
  }
  get log() {
    return path.join(this.dir, 'run.json');
  }
  get report() {
    return path.join(this.dir, 'report.md');
  }
  get devServerLog() {
    return path.join(this.dir, DEV_SERVER_FILES.log);
  }
  get devServerPid() {
    return path.join(this.dir, DEV_SERVER_FILES.pid);
  }
  unitDir(unitId: string) {
    return path.join(this.dir, safeUnitName(unitId));
  }
  roundDir(unitId: string, round: number) {
    return path.join(this.unitDir(unitId), `round-${round}`);
  }
}

export const UNIT_FILES = {
  meta: 'meta.json',
  sections: 'sections.json',
  text: 'text.json',
  dom: 'dom.html',
  styles: 'styles.json',
  animations: 'animations.json',
  snapshot: 'snapshot.html',
  assetsIndex: 'assets/index.json',
  full: 'full.png',
  section: (id: string) => `section-${id}.png`,
  /** per viewport dir, next to full.png */
  video: 'video.webm',
  frames: 'frames',
  frame: (segment: string, n: number) => `${segment}-${String(n).padStart(4, '0')}.png`,
} as const;

/** what verify writes in its outDir, wherever that is: the report the orchestrator and the stop hook read back */
export const VERIFY_FILE = 'verify.json';

/** the files of one round dir */
export const ROUND_FILES = {
  brief: 'brief.md',
  builder: 'builder.json',
  builderStdout: 'builder.stdout.txt',
  builderStderr: 'builder.stderr.txt',
  settings: 'settings.json',
  allowed: 'allowed-files.json',
  stopState: 'stop-hook.json',
  checks: 'checks.txt',
  /** a dir: verifyUnit's outDir for this round */
  verify: 'verify',
  /** a dir: where the stop hook's own verify runs write, reused across the round's holds */
  verifyHook: 'verify-hook',
  /** a dir: where the worker's own `site shot` writes, named in its rule and its brief */
  shots: 'shots',
  reviewBrief: 'review-brief.md',
  reviewer: 'reviewer.json',
  reviewerStdout: 'reviewer.stdout.txt',
  reviewerStderr: 'reviewer.stderr.txt',
  round: 'round.json',
} as const;

/** the files of a browser session dir (`site browser`, SITE_BROWSER_SESSION) */
export const DRIVER_FILES = {
  session: 'browser.json',
  journal: 'journal.json',
  candidates: 'candidates.json',
  /** the hosts the session may open; written when it is opened, read by every open after it */
  allow: 'allow.json',
  log: 'keeper.log',
} as const;

/** the files of one explorer call, under runs/explore-<time>/<page>/ */
export const EXPLORER_FILES = {
  brief: 'brief.md',
  stdout: 'explorer.stdout.txt',
  stderr: 'explorer.stderr.txt',
  record: 'explorer.json',
  /** a dir: the browser session the worker drives */
  session: 'session',
} as const;
