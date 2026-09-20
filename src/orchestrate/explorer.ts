import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import {
  driverCall,
  hostOf,
  readCandidates,
  recordRefusal,
  refuseReason,
  readAllowHosts,
  RefusedUrlError,
  writeAllowHosts,
} from '../capture/driver';
import { DRIVER, type ViewportName } from '../pack/defaults';
import { FLOW_NAME, parseUnitId, unitIdForState } from '../pack/ids';
import { loadManifest, readJson, saveManifest, writeJson } from '../pack/io';
import { DRIVER_FILES, EXPLORER_FILES, PackPaths, RunPaths, safeUnitName } from '../pack/paths';
import {
  BrowserSessionSchema,
  ExplorerOutputSchema,
  type BrowserSession,
  type Candidates,
  type ExplorerOutput,
  type Manifest,
  type StepsFile,
} from '../pack/schemas';
import { briefHeader } from './brief-header';
import { runName } from './build';
import { ORCHESTRATE } from './defaults';
import { siteEnv } from './hooks';
import { processAlive } from './lock';
import { killGroup, runWorker, type WorkerResult } from './worker';

/** the explorer's one tool, and the one command it may run with it; the session dir comes through the environment */
export const EXPLORER_TOOLS = ['Bash'];
export const EXPLORER_ALLOWED = ['Bash(site browser *)'];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * start a keeper for the session, detached, and wait for its session file. a keeper from
 * before goes first: one session, one browser. the keeper's output goes to keeper.log in the
 * session dir, which is what an error here points at.
 *
 * the url is checked before anything is closed or started: a session walks one site, so a
 * scheme that is not http or https and a host the session was not opened for are refused,
 * written into the journal as refusals, and thrown as a RefusedUrlError the worker reads. the
 * hosts come from the caller the first time (the page being explored) and from the session's
 * own allow.json after that, never from the url being asked for.
 *
 * the keeper is told who owns the session, and stops when that process is gone. it is this
 * process by default, which is the orchestrator when `exploreAgent` calls this; it is never the
 * keeper's own parent, which exits as soon as the browser is up (`site browser open` is one
 * command), and a keeper that watched that would stop seconds after it started.
 */
export async function openBrowser(opts: {
  site: string;
  sessionDir: string;
  url: string;
  viewport: ViewportName;
  env?: NodeJS.ProcessEnv;
  /** the hosts this session may open; the session's own list, else this url's host, when absent */
  allowHosts?: string[];
  /** the process this session belongs to; this one when absent */
  ownerPid?: number;
}): Promise<BrowserSession> {
  await fs.mkdir(opts.sessionDir, { recursive: true, mode: 0o700 });
  await fs.chmod(opts.sessionDir, 0o700).catch(() => {});
  const allowHosts = opts.allowHosts ?? (await readAllowHosts(opts.sessionDir)) ?? hostOf(opts.url);
  const refused = refuseReason(opts.url, allowHosts);
  if (refused) {
    await recordRefusal(opts.sessionDir, opts.url, refused);
    throw new RefusedUrlError(refused);
  }
  await closeBrowser(opts.sessionDir);
  await writeAllowHosts(opts.sessionDir, allowHosts);
  const file = path.join(opts.sessionDir, DRIVER_FILES.session);
  const logFile = path.join(opts.sessionDir, DRIVER_FILES.log);
  const log = await fs.open(logFile, 'a');
  const ownerPid = opts.ownerPid ?? process.pid;
  const child = spawn(
    opts.site,
    [
      'browser',
      'keep',
      opts.url,
      '--session',
      opts.sessionDir,
      '--viewport',
      opts.viewport,
      '--owner-pid',
      String(ownerPid),
    ],
    {
      cwd: opts.sessionDir,
      env: { ...process.env, ...opts.env },
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    },
  );
  // the child has its own copy of the descriptor; this one is ours to close
  await log.close();
  const state = { exited: null as number | null };
  child.once('exit', (code) => {
    state.exited = code ?? 1;
  });
  child.unref();
  const until = Date.now() + DRIVER.openTimeoutMs;
  for (;;) {
    try {
      return await readJson(BrowserSessionSchema, file);
    } catch {
      /* not there yet, or half written */
    }
    if (state.exited !== null) {
      throw new Error(
        `the browser keeper exited with ${state.exited} before it opened; see ${logFile}`,
      );
    }
    if (Date.now() > until) {
      // the keeper leads its own group and the chromium it launched is in it: the leader alone
      // would leave a browser nobody owns behind
      if (child.pid !== undefined) killGroup(child.pid, 'SIGKILL');
      throw new Error(`the browser did not open within ${DRIVER.openTimeoutMs} ms; see ${logFile}`);
    }
    await sleep(250);
  }
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (processAlive(pid) && Date.now() < until) await sleep(100);
  return !processAlive(pid);
}

/**
 * is this pid a keeper of this session? a pid comes round again inside a day on macos, so a
 * record that answers nothing may name a stranger by now, and signalling its group would kill
 * whatever it is. the command line answers it: a keeper is `site browser keep <url> --session
 * <this dir>`. anything `ps` cannot tell us is a no.
 */
async function isKeeperOf(pid: number, sessionDir: string): Promise<boolean> {
  const r = await execa('ps', ['-o', 'command=', '-p', String(pid)], { reject: false });
  const command = typeof r.stdout === 'string' ? r.stdout : '';
  return /\bbrowser\s+keep\b/.test(command) && command.includes(sessionDir);
}

/**
 * ask the keeper to close, wait for it, signal its group if it will not; false when there was
 * none. a pid is only signalled when this session's token reached the keeper a moment ago or
 * the session file is recent: a file a killed run left days ago may name a process that has
 * nothing to do with us, and killing that is worse than leaving a stale file behind.
 */
export async function closeBrowser(sessionDir: string): Promise<boolean> {
  const file = path.join(sessionDir, DRIVER_FILES.session);
  let record: BrowserSession;
  try {
    record = await readJson(BrowserSessionSchema, file);
  } catch {
    return false;
  }
  let answered = false;
  try {
    await driverCall(sessionDir, { kind: 'close' });
    answered = true;
  } catch {
    /* the keeper is gone or deaf; the signal below is the answer */
  }
  if (!(await waitGone(record.pid, DRIVER.closeGraceMs))) {
    const age = Date.now() - Date.parse(record.startedAt);
    const recent = Number.isFinite(age) && age >= 0 && age < DRIVER.staleMs;
    // a keeper that answered this session's token a moment ago is ours whatever ps says; a
    // deaf one is signalled only when the record is recent and the process still looks like
    // this session's keeper
    const ours = answered || (recent && (await isKeeperOf(record.pid, sessionDir)));
    if (ours) {
      killGroup(record.pid, 'SIGKILL');
      if (!(await waitGone(record.pid, DRIVER.killGraceMs))) {
        console.warn(`the browser keeper (pid ${record.pid}) is still there after SIGKILL`);
      }
    } else {
      console.warn(
        `${file}: pid ${record.pid} was recorded at ${record.startedAt}, answers nothing and is not a browser keeper of this session; leaving it alone, a pid that old is another process by now`,
      );
    }
  }
  await fs.rm(file, { force: true });
  return true;
}

/**
 * the explorer's brief (spec section 5): what to find, the commands, how to work, the rule
 * about personal data and payment, the answer shape. the states the crawler already found are
 * named so the worker looks for the rest.
 */
export function explorerBrief(input: {
  pageId: string;
  url: string;
  known: string[];
  maxActions: number;
}): string {
  const known = input.known.length ? input.known.map((k) => `\`${k}\``).join(', ') : 'none';
  return [
    briefHeader('explorer', input.pageId, 1),
    `# explore ${input.url}`,
    '',
    '## the task',
    '',
    `find what a crawler cannot: the interactive states of this page (menus, tabs, accordions, modals, drawers, hover states, carousels, form errors) and the flows that start here (a signup, a checkout, a contact form, a search), so they can be captured and rebuilt. you drive a real browser on the page through the \`site browser\` commands below, one Bash call each; every call prints the page after it (url, title, whether a dialog is open, and the interactive elements by role and name). the crawler already found these states, so do not mark them again: ${known}.`,
    '',
    '## the commands',
    '',
    '- `site browser snapshot`: the page as it is now',
    '- `site browser hover --role <role> --name "<name>"` (or `--text "<text>"`, or `--css "<selector>"`): hover an element',
    '- `site browser click ...` (the same ways of naming an element): click one',
    '- `site browser fill ... --value "<text>"`: type into a field',
    '- `site browser state <name>`: mark the page as it is now, reached by everything you did since the last open, as a state named `<name>` (lowercase letters, digits and hyphens: `menu-products-open`, `modal-talk-to-us`)',
    '- `site browser flow <name>`: save everything you did since the last open as a flow named `<name>` (`contact`, `signup`)',
    `- \`site browser open ${input.url}\`: load the page again and start from nothing (the browser is at it already; another page of the same site works too)`,
    '- `site browser close`: close the browser when you are done',
    '',
    '## how to work',
    '',
    '1. read the first snapshot. try every trigger that could change the page: hover a nav item, click a menu button, a tab, an accordion, a button that opens a dialog. when the page changed in a way the crawler would miss, mark it with `state`; then `open` the page again so the next trigger starts from rest.',
    '2. a flow is a sequence: open a dialog, fill its fields, submit. walk it once and save it with `flow`.',
    '3. never fill a field that takes a password, an email, a card number or a one-time code: the tool refuses those and records the field as an input to ask for instead.',
    '4. the tool cannot tell that a field asks for a name, a postal address or a phone number. before you submit any form that collects one, stop, save the flow up to there with `flow`, and ask for what it needs in your questions ("the contact flow needs a name and a postal address"). never submit such a form yourself, never submit a payment and never create an account.',
    `5. stay on this site. at most ${input.maxActions} actions in all; then close the browser.`,
    '6. when you stop, answer with one json object and nothing else: `{"summary": "<what you found>", "questions": ["<what a person has to answer before this can be captured>"]}`; the states and flows you marked are saved by the tool already.',
    '',
  ].join('\n');
}

export interface ExplorerCall {
  root: string;
  manifest: Manifest;
  pageId: string;
  run: RunPaths;
  claude: string;
  site: string;
  model?: string;
  maxTurns: number;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * one explorer worker on one page: the browser opened for it at the page, the worker with
 * Bash on `site browser` only and the session dir in its environment, the browser closed
 * after it whatever happened, and what the tool recorded read back. the worker's answer is
 * returned beside it and never stands in for it.
 */
export async function runExplorer(
  call: ExplorerCall,
): Promise<{ result: WorkerResult<ExplorerOutput>; candidates: Candidates }> {
  const unit = call.manifest.units[call.pageId];
  if (!unit?.url) throw new Error(`${call.pageId} has no url in the manifest`);
  const p = parseUnitId(call.pageId);
  if (p.kind !== 'page') throw new Error(`${call.pageId} is not a page`);
  const dir = call.run.unitDir(call.pageId);
  const sessionDir = path.join(dir, EXPLORER_FILES.session);
  await fs.mkdir(sessionDir, { recursive: true });
  const known = Object.keys(call.manifest.units).flatMap((id) => {
    const q = parseUnitId(id);
    return q.kind === 'state' && q.slug === p.slug ? [q.state] : [];
  });
  await openBrowser({
    site: call.site,
    sessionDir,
    url: unit.url,
    viewport: 'desktop',
    env: call.env,
    // the pack's host and this page's: the worker may open another page of the same site and
    // nothing else, whatever url it asks for
    allowHosts: [...new Set([call.manifest.host, ...hostOf(unit.url)])],
  });
  try {
    const result = await runWorker<ExplorerOutput>({
      role: 'explorer',
      claude: call.claude,
      cwd: sessionDir,
      brief: explorerBrief({
        pageId: call.pageId,
        url: unit.url,
        known,
        maxActions: ORCHESTRATE.explorerActions,
      }),
      maxTurns: call.maxTurns,
      timeoutMs: call.timeoutMs,
      tools: EXPLORER_TOOLS,
      allowedTools: EXPLORER_ALLOWED,
      settingsFile: null,
      addDirs: [],
      schema: ExplorerOutputSchema,
      outDir: dir,
      files: {
        brief: EXPLORER_FILES.brief,
        stdout: EXPLORER_FILES.stdout,
        stderr: EXPLORER_FILES.stderr,
        record: EXPLORER_FILES.record,
      },
      // the session dir and the owner of every browser this worker opens, both through the
      // environment, which the worker cannot redirect (its one rule is `Bash(site browser *)`).
      // the brief tells it to `site browser open` the page again after every state it marks,
      // and the shell that runs that command may not outlive the call: this process is the one
      // that outlives every keeper the worker starts, so it is the owner, not the worker's
      // shell. runWorker lays these over process.env and strips the claude session variables
      // after, and neither of these is one of those
      env: {
        ...call.env,
        SITE_BROWSER_SESSION: sessionDir,
        SITE_BROWSER_OWNER: String(process.pid),
      },
      model: call.model,
      signal: call.signal,
    });
    return { result, candidates: await readCandidates(sessionDir) };
  } finally {
    await closeBrowser(sessionDir);
  }
}

/**
 * what the tool recorded goes into the plan: a candidate state becomes a planned state unit of
 * the page whose url it was marked on (skipped when that page is not in the manifest, when it
 * has no actions, when its name is not a unit id segment, or when the unit exists); a
 * candidate flow becomes steps/<flow>.json and a flow entry whose inputs are unset, with one
 * input question each (skipped when the flow exists); the worker's questions become plain
 * questions. the manifest is changed in place; the caller saves it.
 */
export async function mergeExplorer(
  root: string,
  manifest: Manifest,
  pageId: string,
  candidates: Candidates,
  output: ExplorerOutput | null,
  now: string = new Date().toISOString(),
): Promise<{ states: string[]; flows: string[]; questions: string[] }> {
  const pack = new PackPaths(root);
  const out = { states: [] as string[], flows: [] as string[], questions: [] as string[] };
  for (const s of candidates.states) {
    if (!FLOW_NAME.test(s.name) || !s.actions.length) continue;
    const owner = Object.entries(manifest.units).find(
      ([, u]) => u.kind === 'page' && u.url === s.url,
    )?.[0];
    if (!owner) continue;
    const q = parseUnitId(owner);
    if (q.kind !== 'page') continue;
    const id = unitIdForState(q.slug, s.name);
    if (manifest.units[id]) continue;
    manifest.units[id] = {
      kind: 'state',
      status: 'planned',
      url: s.url,
      dependsOn: [owner],
      rounds: 0,
      updatedAt: now,
      actions: s.actions,
      reachable: [s.viewport],
    };
    out.states.push(id);
  }
  for (const f of candidates.flows) {
    if (!FLOW_NAME.test(f.name) || !f.steps.length || manifest.flows[f.name]) continue;
    const file: StepsFile = { flow: f.name, start: f.start, recordedAt: now, steps: f.steps };
    await writeJson(pack.stepsFile(f.name), file);
    const inputs: Record<string, string | null> = {};
    for (const name of [...f.steps.flatMap((s) => (s.input ? [s.input] : [])), ...f.inputs]) {
      inputs[name] = null;
    }
    manifest.flows[f.name] = { steps: [], inputs };
    for (const name of Object.keys(inputs)) {
      const id = `flow:${f.name}:input:${name}`;
      if (manifest.questions.some((q) => q.id === id)) continue;
      manifest.questions.push({
        id,
        text: `flow "${f.name}" needs a value for "${name}": the explorer did not fill it. set manifest.flows.${f.name}.inputs.${name} before replaying.`,
      });
    }
    out.flows.push(f.name);
  }
  for (const asked of output?.questions ?? []) {
    const text = `${pageId}: ${asked}`;
    // the same question twice (a worker that repeats itself, a page explored again) is one
    // question, the way an input question is
    if (manifest.questions.some((q) => q.text === text)) continue;
    const prefix = `q-explorer-${safeUnitName(pageId)}-`;
    const id = `${prefix}${manifest.questions.filter((q) => q.id.startsWith(prefix)).length + 1}`;
    manifest.questions.push({ id, text });
    out.questions.push(id);
  }
  return out;
}

/**
 * `site explore --agent`: after the crawl, one explorer worker per page that is not blocked,
 * each merged and saved before the next. a worker that did not finish (crashed, out of turns)
 * still leaves what its browser recorded, and that is merged; only its answer is lost.
 */
export async function exploreAgent(opts: {
  root: string;
  claude: string;
  site: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  log?: (line: string) => void;
}): Promise<{
  run: string;
  states: string[];
  flows: string[];
  questions: string[];
  outcomes: Record<string, string>;
}> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const manifest = await loadManifest(opts.root);
  const run = new RunPaths(opts.root, `explore-${runName()}`);
  const env = siteEnv(opts.site, opts.env);
  const out = {
    run: run.run,
    states: [] as string[],
    flows: [] as string[],
    questions: [] as string[],
    outcomes: {} as Record<string, string>,
  };
  const pages = Object.entries(manifest.units)
    .filter(([, u]) => u.kind === 'page' && u.url && u.status !== 'blocked')
    .map(([id]) => id)
    .sort();
  for (const pageId of pages) {
    log(`${pageId}: exploring with a worker`);
    const { result, candidates } = await runExplorer({
      root: opts.root,
      manifest,
      pageId,
      run,
      claude: opts.claude,
      site: opts.site,
      model: opts.model,
      maxTurns: ORCHESTRATE.explorerTurns,
      timeoutMs: ORCHESTRATE.explorerTimeoutMs,
      env,
      signal: opts.signal,
    });
    out.outcomes[pageId] = result.outcome;
    if (result.outcome !== 'done') {
      log(
        `${pageId}: explorer ${result.outcome}${result.reason ? `: ${result.reason}` : ''}; keeping what its browser recorded`,
      );
    }
    const merged = await mergeExplorer(opts.root, manifest, pageId, candidates, result.output);
    out.states.push(...merged.states);
    out.flows.push(...merged.flows);
    out.questions.push(...merged.questions);
    log(
      `${pageId}: ${merged.states.length} states, ${merged.flows.length} flows, ${merged.questions.length} questions`,
    );
    await saveManifest(opts.root, manifest);
  }
  return out;
}
