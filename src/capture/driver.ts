/**
 * the browser an explorer worker drives through `site browser`. a `claude -p` worker's every
 * Bash call is a fresh process, so the page has to live somewhere that outlives them: a keeper
 * process (`site browser keep`, started detached by `site browser open`) owns one playwright
 * page and takes commands over a local http port, one at a time; `snapshot`, `hover`, `click`
 * and `fill` post one command each and print what came back. the keeper is the only thing
 * that touches the page and the only writer of a step in the journal, so what a worker marks
 * as a state or a flow is the journal's own actions, never the worker's claims. nothing here
 * spawns: the spawn is orchestrate's (explorer.ts).
 *
 * two things guard the keeper, because its port is open to every process on the machine, the
 * pages it visits included (a page can fetch a loopback port no-cors, and a request it cannot
 * read the answer to would still have acted):
 * - a token: 32 random bytes the keeper makes at startup and writes into browser.json for this
 *   user only (0600, in a 0700 dir). a request without it, or with another one, is answered 401
 *   before its body is read, so it acts on nothing.
 * - an allowlist: the hosts this session may open, in allow.json, set when the session is
 *   opened and inherited by every open after it. another host, or a scheme that is not http or
 *   https, is refused without navigating and written into the journal's refusals.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { DEFAULT_VIEWPORTS, DRIVER, STATE, type ViewportName } from '../pack/defaults';
import { FLOW_NAME } from '../pack/ids';
import { readJson, writeJsonAtomic } from '../pack/io';
import { DRIVER_FILES } from '../pack/paths';
import {
  AllowHostsSchema,
  BrowserSessionSchema,
  CandidatesSchema,
  DriverCommandSchema,
  DriverReplySchema,
  JournalSchema,
  type Action,
  type BrowserSession,
  type Candidates,
  type DriverCommand,
  type DriverReply,
  type Journal,
  type Target,
} from '../pack/schemas';
import { inPage } from './browser/in-page';
import { describeTarget as describeTargetHelper } from './browser/targets';
import { isSensitiveField } from './record';
import { performAction, resolveTarget } from './replay';
import { contextOptionsFor } from './session';
import { settle } from './settle';
import { findTriggersInPage } from './states';

// declared in the page by inPage(fn, [describeTargetHelper]); see in-page.ts
declare function describeTarget(el: Element): Target;

/** the header every command carries; node lowercases what it reads off the wire */
export const TOKEN_HEADER = 'x-site-browser-token';

/** the session dir is this user's alone: it holds the token that drives the browser */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** a url this session will not open, with the reason a worker is told */
export class RefusedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedUrlError';
  }
}

/** the host of a url, or nothing when it is not one */
export function hostOf(url: string): string[] {
  try {
    return [new URL(url).host];
  } catch {
    return [];
  }
}

/**
 * why this session will not open this url, or null when it will. a browser session exists to
 * walk one site: a scheme that is not http or https reaches the filesystem and the browser's
 * own pages, and another host is not what the pack is about.
 */
export function refuseReason(url: string, allowHosts: string[]): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `${url} is not a url`;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return `${url}: a browser session opens http and https only`;
  }
  if (!allowHosts.includes(u.host)) {
    const list = allowHosts.length ? allowHosts.join(', ') : 'nothing';
    return `${url}: this session may only open ${list}`;
  }
  return null;
}

/**
 * the hosts this session may open, or null when it has none on record yet. only a file that is
 * not there says nothing: one that cannot be read or is not a list of hosts is a damaged guard,
 * and a guard that opens whatever it is handed when its record is damaged is no guard at all,
 * so every open is refused until a person looks at the file this names.
 */
export async function readAllowHosts(sessionDir: string): Promise<string[] | null> {
  const file = path.join(sessionDir, DRIVER_FILES.allow);
  try {
    return await readJson(AllowHostsSchema, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new RefusedUrlError(
      `${file}: this session's allow list cannot be read, so nothing is opened until it is fixed or removed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function writeAllowHosts(sessionDir: string, hosts: string[]): Promise<void> {
  await fs.mkdir(sessionDir, { recursive: true, mode: DIR_MODE });
  await writeJsonAtomic(path.join(sessionDir, DRIVER_FILES.allow), AllowHostsSchema.parse(hosts), {
    mode: FILE_MODE,
  });
}

/**
 * a refused open, written where the run's own record is. the keeper writes every step; this is
 * the one journal write from the client side, because a refusal never reaches the keeper. with
 * no session there is nothing to write into, and the caller's error is the whole answer.
 */
export async function recordRefusal(
  sessionDir: string,
  url: string,
  reason: string,
): Promise<void> {
  let journal: Journal;
  try {
    journal = await readJournal(sessionDir);
  } catch {
    return;
  }
  journal.refusals.push({ url, reason, at: new Date().toISOString() });
  await writeJournal(sessionDir, journal);
}

interface FieldsInPage {
  fields: { target: Target; type: string; name: string; value: string }[];
  links: { target: Target; href: string }[];
  /** the open dialog's name, or null */
  dialog: string | null;
}

/** in-page: the visible fields and links and the open dialog, for the snapshot; self-contained apart from describeTarget */
export function listFieldsInPage(opts: { max: number }): FieldsInPage {
  function visible(el: Element): boolean {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function clean(s: string | null | undefined): string {
    return (s ?? '').replace(/\s+/g, ' ').trim();
  }
  const fields: FieldsInPage['fields'] = [];
  document.querySelectorAll('input, select, textarea').forEach((el) => {
    if (fields.length >= opts.max || !visible(el)) return;
    const tag = el.tagName;
    const type = (
      el.getAttribute('type') ||
      (tag === 'SELECT' ? 'select' : tag === 'TEXTAREA' ? 'textarea' : 'text')
    ).toLowerCase();
    if (type === 'hidden') return;
    fields.push({
      target: describeTarget(el),
      type,
      name: el.getAttribute('name') || el.getAttribute('id') || '',
      // a password's value never leaves the page, not even into a snapshot
      value: type === 'password' ? '' : clean((el as HTMLInputElement).value),
    });
  });
  const links: FieldsInPage['links'] = [];
  document.querySelectorAll('a[href]').forEach((el) => {
    if (links.length >= opts.max || !visible(el)) return;
    links.push({ target: describeTarget(el), href: el.getAttribute('href') || '' });
  });
  const dialogEl = Array.from(
    document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]'),
  ).find((el) => visible(el));
  let dialog: string | null = null;
  if (dialogEl) {
    const by = dialogEl.getAttribute('aria-labelledby');
    dialog =
      clean(dialogEl.getAttribute('aria-label')) ||
      clean(by ? document.getElementById(by)?.textContent : '') ||
      'open';
  }
  return { fields, links, dialog };
}

function targetLine(t: Target): string {
  const head = t.role ? `${t.role.role} "${t.role.name}"` : t.text ? `text "${t.text}"` : 'no name';
  return `${head}  css=${t.css}`;
}

/**
 * the page as one text: url, title, the open dialog, then the interactive elements the state
 * discovery would try (by kind) and the visible fields and links, each by role and name so a
 * worker can name it back. capped, because a long page is not worth a long prompt.
 */
export async function snapshotOf(page: Page): Promise<string> {
  const triggers = await page.evaluate(inPage(findTriggersInPage, [describeTargetHelper]), {
    max: STATE.maxTriggers,
  });
  const rest = await page.evaluate(inPage(listFieldsInPage, [describeTargetHelper]), {
    max: DRIVER.snapshotMax,
  });
  const lines = [
    `url: ${page.url()}`,
    `title: ${await page.title()}`,
    `dialog: ${rest.dialog ?? 'none'}`,
    'elements:',
  ];
  const seen = new Set<string>();
  let dropped = 0;
  const push = (kind: string, t: Target, extra = '') => {
    const line = `  ${kind.padEnd(9)} ${targetLine(t)}${extra}`;
    if (seen.has(line)) return;
    seen.add(line);
    if (lines.length >= DRIVER.snapshotMax + 4) dropped += 1;
    else lines.push(line);
  };
  for (const t of triggers) push(t.kind, t.target);
  const listed = new Set(triggers.map((t) => t.target.css));
  for (const f of rest.fields) {
    push(
      'field',
      f.target,
      `  type=${f.type}${f.name ? ` name=${f.name}` : ''}${f.value ? ` value="${f.value}"` : ''}`,
    );
  }
  for (const l of rest.links)
    if (!listed.has(l.target.css)) push('link', l.target, `  href=${l.href}`);
  if (dropped) lines.push(`  ... ${dropped} more; name any element by role and name, text, or css`);
  return lines.join('\n');
}

function describeElement(el: Element): Target {
  return describeTarget(el);
}

/** the same token, compared in constant time; a different length is a different token */
function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * browser.json, whole or not at all, and readable by this user only: it carries the token that
 * drives the browser, and a client that read half of it would report no browser at all.
 */
async function writeSession(file: string, record: BrowserSession): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(BrowserSessionSchema.parse(record), null, 2) + '\n', {
    mode: FILE_MODE,
  });
  // the mode above only applies to a file this call creates; a leftover tmp would keep its own
  await fs.chmod(tmp, FILE_MODE);
  await fs.rename(tmp, file);
}

async function writeJournal(sessionDir: string, journal: Journal): Promise<void> {
  await writeJsonAtomic(path.join(sessionDir, DRIVER_FILES.journal), JournalSchema.parse(journal), {
    mode: FILE_MODE,
  });
}

/**
 * back to where the page was before an action took it off the allowed hosts. a link followed
 * in the same tab leaves a history entry; a navigation that replaced the page without one
 * leaves none, and then the url this session was opened at is where the page goes. a step back
 * that lands on another foreign page is no better than the one we left, so it is checked too.
 */
async function goBackTo(page: Page, url: string, allowHosts: string[]): Promise<void> {
  try {
    const back = await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (back && !refuseReason(page.url(), allowHosts)) return;
  } catch {
    /* no history entry, or the step back timed out: the session's own url is the way home */
  }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
}

/**
 * is the process that owns this session still there? the same probe the lock makes (signal 0,
 * EPERM meaning it exists and is somebody else's), written here rather than imported: capture
 * imports pack only, and orchestrate is where the lock lives.
 */
function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * the keeper: one page at the viewport, the url loaded and settled, then commands over http
 * until `close`, a signal, the owner going, or DRIVER.idleMs without a command (every command
 * touches browser.json; a worker that forgot to close must not hold a chromium for ever). every
 * command carries the session's token or is answered 401 without being read. the journal is
 * written after every action; the session file is removed on the way out, which is how the
 * clients learn the browser is gone.
 */
export async function keepBrowser(opts: {
  sessionDir: string;
  url: string;
  viewport: ViewportName;
  /**
   * the process this session belongs to: the orchestrator, or the shell that ran
   * `site browser open`. never this keeper's own parent, which exits as soon as the browser is
   * up; the caller passes it and the record carries it.
   */
  ownerPid: number;
  headless?: boolean;
  /** the hosts this session may open; the session's own allow.json when absent */
  allowHosts?: string[];
}): Promise<void> {
  await fs.mkdir(opts.sessionDir, { recursive: true, mode: DIR_MODE });
  await fs.chmod(opts.sessionDir, DIR_MODE).catch(() => {});
  // the same check the open made, made again here: `keep` is a command of its own, and a
  // keeper that navigated anywhere would make the check in front of it decoration
  const allowHosts = opts.allowHosts ?? (await readAllowHosts(opts.sessionDir)) ?? hostOf(opts.url);
  const refused = refuseReason(opts.url, allowHosts);
  if (refused) throw new RefusedUrlError(refused);
  const file = path.join(opts.sessionDir, DRIVER_FILES.session);
  const token = crypto.randomBytes(32).toString('hex');
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'site-browser-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: opts.headless ?? true,
    ...contextOptionsFor(DEFAULT_VIEWPORTS[opts.viewport]),
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const journal: Journal = { url: opts.url, viewport: opts.viewport, steps: [], refusals: [] };
  let stop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });

  const reply = (partial: Partial<DriverReply>): DriverReply => ({
    ok: true,
    snapshot: '',
    note: null,
    error: null,
    ...partial,
  });

  const act = async (action: Action): Promise<DriverReply> => {
    if (!action.target) return reply({ ok: false, error: `${action.kind} has no target` });
    const locator = await resolveTarget(page, action.target);
    if (!locator) {
      return reply({
        ok: false,
        snapshot: await snapshotOf(page),
        error: `no visible element for ${targetLine(action.target)}`,
      });
    }
    // the element as the page describes it (role and name, text, css path), the way the
    // recorder journals it, so a replay finds it again however the worker named it
    const handle = await locator.elementHandle();
    let target: Target;
    try {
      target = await page.evaluate(inPage(describeElement, [describeTargetHelper]), handle);
    } finally {
      // one handle per action would pile up in a long session, and the page holds it too
      await handle?.dispose().catch(() => {});
    }
    let recorded: Action = { ...action, target };
    let note: string | null = null;
    if (action.kind === 'input') {
      // the recorder's rule: a field for a password, an email, a card or a code is never
      // filled and its value never kept; the step carries the field's name as the input to ask for
      const field = await locator.evaluate((el) => ({
        type: el.getAttribute('type') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        name: el.getAttribute('name') || '',
        id: el.getAttribute('id') || '',
      }));
      if (isSensitiveField({ ...field, value: action.value ?? '' })) {
        const name = field.name || field.id || target.role?.name || 'field';
        recorded = { ...recorded, value: null, input: name };
        note = `needs input "${name}": this field takes personal data or a payment, so it was not filled and the value was not kept. save the flow up to here (site browser flow <name>) and put what it needs in your questions.`;
      }
    }
    const masked = recorded.kind === 'input' && recorded.input !== null;
    if (!masked) await performAction(page, recorded, {});
    await page.waitForTimeout(STATE.afterAction);
    // where the action left the page: a link to another host (a social icon, a partner logo,
    // "powered by") navigates there, and every later hover, click and fill would act on that
    // site with this worker's whole command set. the allow list is checked again here, the
    // page is taken back, the step is not journalled and the worker is told why
    const landed = page.url();
    const leaving = refuseReason(landed, allowHosts);
    if (leaving) {
      journal.refusals.push({ url: landed, reason: leaving, at: new Date().toISOString() });
      await writeJournal(opts.sessionDir, journal);
      await goBackTo(page, journal.url, allowHosts);
      return reply({ ok: false, snapshot: await snapshotOf(page), error: leaving });
    }
    journal.steps.push({
      ...recorded,
      n: journal.steps.length + 1,
      url: page.url(),
      at: new Date().toISOString(),
    });
    await writeJournal(opts.sessionDir, journal);
    return reply({ snapshot: await snapshotOf(page), note });
  };

  const answer = async (body: string): Promise<DriverReply> => {
    let command: DriverCommand;
    try {
      command = DriverCommandSchema.parse(JSON.parse(body));
    } catch {
      return reply({ ok: false, error: 'not a browser command' });
    }
    const now = new Date();
    await fs.utimes(file, now, now).catch(() => {});
    try {
      if (command.kind === 'close') {
        setTimeout(stop, 0);
        return reply({ note: 'closing' });
      }
      if (command.kind === 'act') return await act(command.action);
      return reply({ snapshot: await snapshotOf(page) });
    } catch (err) {
      return reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // one command at a time: a second one that arrives early waits rather than acting on a
  // page mid-click
  let queue: Promise<unknown> = Promise.resolve();
  const server = http.createServer((req, res) => {
    const given = req.headers[TOKEN_HEADER];
    if (typeof given !== 'string' || !sameToken(given, token)) {
      // before the body is read, so an unauthenticated request acts on nothing and journals
      // nothing; the body is drained so the caller reads the answer rather than a reset
      req.resume();
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end(`this browser keeper acts on a request carrying ${TOKEN_HEADER}\n`);
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const run = queue.then(() => answer(Buffer.concat(chunks).toString('utf8')));
      queue = run.catch(() => undefined);
      run.then(
        (r) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r));
        },
        (err: unknown) => {
          res.writeHead(500);
          res.end(err instanceof Error ? err.message : String(err));
        },
      );
    });
  });

  const onSignal = () => stop();
  let idle: ReturnType<typeof setInterval> | null = null;
  try {
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('load', { timeout: 60_000 }).catch(() => {});
    await settle(page);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    await writeJournal(opts.sessionDir, journal);
    const record: BrowserSession = {
      endpoint: `http://127.0.0.1:${port}/`,
      pid: process.pid,
      ownerPid: opts.ownerPid,
      startedAt: new Date().toISOString(),
      url: opts.url,
      viewport: opts.viewport,
      token,
    };
    await writeSession(file, record);
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    idle = setInterval(() => {
      // the run this session belongs to is gone (a SIGKILL of `site build` or
      // `site explore --agent` runs no cleanup): nothing will read what this browser does and
      // nobody will close it, so it goes now rather than in twenty minutes
      if (!ownerAlive(opts.ownerPid)) {
        console.warn(`the process that owns this session (pid ${opts.ownerPid}) is gone; closing`);
        stop();
        return;
      }
      fs.stat(file).then(
        (s) => {
          if (Date.now() - s.mtimeMs > DRIVER.idleMs) stop();
        },
        // the session file is gone: somebody closed the session under us
        () => stop(),
      );
    }, DRIVER.pollMs);
    await stopped;
  } finally {
    if (idle) clearInterval(idle);
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    await fs.rm(file, { force: true });
    server.close();
    await context.close().catch(() => {});
    await fs.rm(profile, { recursive: true, force: true });
  }
}

/** the session on record, or null when there is none to read */
export async function readSession(sessionDir: string): Promise<BrowserSession | null> {
  try {
    return await readJson(BrowserSessionSchema, path.join(sessionDir, DRIVER_FILES.session));
  } catch {
    return null;
  }
}

/** the client side of one command: the session file names the keeper and carries its token */
export async function driverCall(sessionDir: string, command: DriverCommand): Promise<DriverReply> {
  const file = path.join(sessionDir, DRIVER_FILES.session);
  let record: BrowserSession;
  try {
    record = await readJson(BrowserSessionSchema, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('no browser is open: run `site browser open <url>` first');
    }
    throw err;
  }
  const res = await fetch(record.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [TOKEN_HEADER]: record.token },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(command.kind === 'close' ? 10_000 : 90_000),
  });
  if (res.status === 401) {
    throw new Error(`${file} does not carry the token this keeper was started with`);
  }
  if (!res.ok) throw new Error(`the browser keeper answered http ${res.status}`);
  return DriverReplySchema.parse(await res.json());
}

export async function readJournal(sessionDir: string): Promise<Journal> {
  try {
    return await readJson(JournalSchema, path.join(sessionDir, DRIVER_FILES.journal));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('no browser is open: run `site browser open <url>` first');
    }
    throw err;
  }
}

/**
 * what was marked so far; nothing yet is an empty pair, not an error, and neither is a file
 * that does not read as one: a worker killed in the middle of a write costs its own page's
 * candidates, and must not take down the loop that was about to merge every other page's.
 */
export async function readCandidates(sessionDir: string): Promise<Candidates> {
  const file = path.join(sessionDir, DRIVER_FILES.candidates);
  try {
    return await readJson(CandidatesSchema, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(
        `${file}: ignored, nothing was marked that can be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { states: [], flows: [] };
  }
}

async function writeCandidates(sessionDir: string, c: Candidates): Promise<void> {
  await writeJsonAtomic(path.join(sessionDir, DRIVER_FILES.candidates), CandidatesSchema.parse(c), {
    mode: FILE_MODE,
  });
}

/** a state name is a unit id segment, so it takes the flow name's alphabet */
function checkName(name: string, what: string): void {
  if (!FLOW_NAME.test(name)) {
    throw new Error(`${what} name must be lowercase letters, digits and hyphens, got "${name}"`);
  }
}

/** the page as it is now, reached by every action since the open, as a candidate state (by name; a repeat replaces) */
export async function markState(
  sessionDir: string,
  name: string,
): Promise<Candidates['states'][number]> {
  checkName(name, 'state');
  const journal = await readJournal(sessionDir);
  if (!journal.steps.length) {
    throw new Error('nothing was done since the open: the page at rest is not a state');
  }
  const actions: Action[] = journal.steps.map(({ n: _n, url: _url, at: _at, ...action }) => action);
  const state = { url: journal.url, name, viewport: journal.viewport, actions };
  const c = await readCandidates(sessionDir);
  c.states = [...c.states.filter((s) => s.name !== name), state];
  await writeCandidates(sessionDir, c);
  return state;
}

/** every action since the open as a candidate flow, its inputs the masked fields plus what the caller names */
export async function markFlow(
  sessionDir: string,
  name: string,
  extraInputs: string[],
): Promise<Candidates['flows'][number]> {
  checkName(name, 'flow');
  const journal = await readJournal(sessionDir);
  if (!journal.steps.length) {
    throw new Error('nothing was done since the open: there is no flow to save');
  }
  const inputs = [
    ...new Set([...journal.steps.flatMap((s) => (s.input ? [s.input] : [])), ...extraInputs]),
  ];
  const flow = { name, start: journal.url, steps: journal.steps, inputs };
  const c = await readCandidates(sessionDir);
  c.flows = [...c.flows.filter((f) => f.name !== name), flow];
  await writeCandidates(sessionDir, c);
  return flow;
}
