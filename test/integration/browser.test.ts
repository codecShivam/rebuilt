import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../helpers/serve';
import { isSensitiveField } from '../../src/capture/record';
import { readCandidates, TOKEN_HEADER } from '../../src/capture/driver';
import { readJson, writeJson } from '../../src/pack/io';
import {
  AllowHostsSchema,
  BrowserSessionSchema,
  CandidatesSchema,
  JournalSchema,
} from '../../src/pack/schemas';
import { closeBrowser, openBrowser } from '../../src/orchestrate/explorer';
import { processAlive } from '../../src/orchestrate/lock';
import { DRIVER } from '../../src/pack/defaults';

const bin = path.resolve('bin/site');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let server: Awaited<ReturnType<typeof serveStatic>>;
let work: string;
let session: string;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'site-browser-')));
  session = path.join(work, 'session');
  // the session dir the way a worker gets it: through the environment, which it cannot redirect
  env = {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
    SITE_BROWSER_SESSION: session,
  };
});
afterAll(async () => {
  // every step of the cleanup runs before the assertion below, so a keeper cannot outlive a
  // failure here; nothing this file opened outlives it, because a keeper holds a chromium and
  // is spawned detached. scoped to this work dir, so another run's keeper is not ours: every
  // session this file opens is a dir under it
  await closeBrowser(session);
  for (const dir of extraSessions) await closeBrowser(dir);
  await server.close();
  await fs.rm(work, { recursive: true, force: true });
  const left = await execa('pgrep', ['-f', `browser keep .*${work}`], { reject: false });
  expect(left.stdout.trim()).toBe('');
});

/** the session dirs the tests below open beside the shared one; closed in afterAll whatever happens */
const extraSessions: string[] = [];
async function openSessionDir(name: string): Promise<{ dir: string; env: NodeJS.ProcessEnv }> {
  const dir = path.join(work, name);
  await fs.mkdir(dir, { recursive: true });
  extraSessions.push(dir);
  return { dir, env: { ...env, SITE_BROWSER_SESSION: dir } };
}

const site = (...args: string[]) => execa(bin, ['browser', ...args], { env, reject: false });

describe('site browser', () => {
  it('refuses every command until a browser is open', async () => {
    for (const args of [['snapshot'], ['click', '--text', 'x'], ['state', 'x'], ['flow', 'x']]) {
      const r = await site(...args);
      expect(r.exitCode, args.join(' ')).toBe(1);
      expect(r.stderr, args.join(' ')).toMatch(/no browser is open/);
    }
    expect((await site('close')).stdout.trim()).toBe('no browser was open');
  });

  it('opens the page, lists its triggers, clicks by role and name, and marks the state the journal reached', async () => {
    const opened = await site('open', `${server.url}/`);
    expect(opened.exitCode, opened.stderr).toBe(0);
    expect(opened.stdout).toContain(`url: ${server.url}/`);
    expect(opened.stdout).toContain('title: Fixture Co');
    expect(opened.stdout).toContain('dialog: none');
    expect(opened.stdout).toMatch(/button\s+button "Talk to us"/);
    expect(opened.stdout).toMatch(/accordion\s+text "Is it accurate\?"/);
    expect(opened.stdout).toMatch(/hover\s+button "Products"/);
    // inside the hidden modal: not visible, not listed
    expect(opened.stdout).not.toContain('"Email"');
    const record = await readJson(BrowserSessionSchema, path.join(session, 'browser.json'));
    expect(processAlive(record.pid)).toBe(true);
    expect(record).toMatchObject({ url: `${server.url}/`, viewport: 'desktop' });

    const clicked = await site('click', '--role', 'button', '--name', 'Talk to us');
    expect(clicked.exitCode, clicked.stderr).toBe(0);
    expect(clicked.stdout).toContain('dialog: Talk to us');
    expect(clicked.stdout).toMatch(/field\s+textbox "Email"\s+css=\S+\s+type=email name=email/);

    const marked = await site('state', 'modal-talk-to-us');
    expect(marked.exitCode, marked.stderr).toBe(0);
    expect(marked.stdout.trim()).toBe(`state modal-talk-to-us: 1 action from ${server.url}/`);
    const candidates = await readJson(CandidatesSchema, path.join(session, 'candidates.json'));
    expect(candidates.states).toHaveLength(1);
    expect(candidates.states[0]).toMatchObject({
      url: `${server.url}/`,
      name: 'modal-talk-to-us',
      viewport: 'desktop',
    });
    // the journal records the element as the page describes it, the way the recorder does, so
    // a replay finds it by role and name first and by its css last
    expect(candidates.states[0]!.actions).toEqual([
      {
        kind: 'click',
        target: {
          role: { role: 'button', name: 'Talk to us' },
          text: 'Talk to us',
          css: '#open-modal',
        },
        value: null,
        input: null,
        scroll: null,
      },
    ]);
    const bad = await site('state', 'Bad Name');
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toMatch(/lowercase letters, digits and hyphens/);
    const nothing = await site('click', '--role', 'button', '--name', 'No such button');
    expect(nothing.exitCode).toBe(1);
    expect(nothing.stderr).toMatch(/no visible element/);
  }, 120_000);

  it('acts on nothing for a request that does not carry the session token', async () => {
    // the no-op negative is the test above: with the token, that click acted and was journalled.
    // the keeper's port is open to every process on this machine, the pages it visits included,
    // so a request without the token must be refused before its body is even read
    const record = await readJson(BrowserSessionSchema, path.join(session, 'browser.json'));
    expect(record.token).toMatch(/^[0-9a-f]{64}$/);
    const journalFile = path.join(session, 'journal.json');
    const before = await fs.readFile(journalFile, 'utf8');
    const close = {
      kind: 'act',
      action: {
        kind: 'click',
        target: { role: null, text: null, css: '#close-modal' },
        value: null,
        input: null,
        scroll: null,
      },
    };
    const tries: Record<string, string>[] = [
      {},
      { [TOKEN_HEADER]: 'f'.repeat(64) },
      { [TOKEN_HEADER]: 'short' },
    ];
    for (const headers of tries) {
      const res = await fetch(record.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(close),
      });
      expect(res.status, JSON.stringify(headers)).toBe(401);
    }
    // the same endpoint, the same shape of request, the token: answered. so the 401s above are
    // about the token and nothing else
    const allowed = await fetch(record.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [TOKEN_HEADER]: record.token },
      body: JSON.stringify({ kind: 'snapshot' }),
    });
    expect(allowed.status).toBe(200);
    // nothing was journalled, and the modal that click would have closed is still open
    expect(await fs.readFile(journalFile, 'utf8')).toBe(before);
    const after = await site('snapshot');
    expect(after.exitCode, after.stderr).toBe(0);
    expect(after.stdout).toContain('dialog: Talk to us');
  }, 120_000);

  it('never fills a field that takes personal data: the value stays out of the page and the step asks for an input', async () => {
    // the no-op negative: the rule itself, on a plain text field, says no
    expect(
      isSensitiveField({ type: 'text', autocomplete: '', name: 'q', id: '', value: 'hi' }),
    ).toBe(false);
    expect(
      isSensitiveField({ type: 'email', autocomplete: '', name: 'email', id: '', value: '' }),
    ).toBe(true);
    const filled = await site(
      'fill',
      '--role',
      'textbox',
      '--name',
      'Email',
      '--value',
      'ada@example.com',
    );
    expect(filled.exitCode, filled.stderr).toBe(0);
    expect(filled.stdout).toContain('note: needs input "email"');
    // the snapshot after shows the field still empty
    expect(filled.stdout).not.toContain('ada@example.com');
    const journal = await readJson(JournalSchema, path.join(session, 'journal.json'));
    expect(journal.steps).toHaveLength(2);
    expect(journal.steps[1]).toMatchObject({ n: 2, kind: 'input', value: null, input: 'email' });
    const flow = await site('flow', 'contact');
    expect(flow.exitCode, flow.stderr).toBe(0);
    expect(flow.stdout.trim()).toBe(`flow contact: 2 steps from ${server.url}/, inputs: email`);
    const candidates = await readJson(CandidatesSchema, path.join(session, 'candidates.json'));
    expect(candidates.states).toHaveLength(1);
    expect(candidates.flows).toHaveLength(1);
    expect(candidates.flows[0]).toMatchObject({
      name: 'contact',
      start: `${server.url}/`,
      inputs: ['email'],
    });
    expect(candidates.flows[0]!.steps.map((s) => [s.n, s.kind])).toEqual([
      [1, 'click'],
      [2, 'input'],
    ]);
    expect(candidates.flows[0]!.steps[1]!.value).toBeNull();
    // a flow name is a file name and a unit id segment
    expect((await site('flow', 'Sign Up')).exitCode).not.toBe(0);
  }, 120_000);

  it('opens this site over http only, refusing another scheme and another host', async () => {
    // the no-op negative: this site's own url opened above, and the page is still on it
    const before = await readJson(JournalSchema, path.join(session, 'journal.json'));
    expect(before.refusals).toEqual([]);
    for (const [url, pattern] of [
      ['file:///etc/passwd', /http and https only/],
      ['http://example.com/', /may only open/],
    ] as const) {
      const r = await site('open', url);
      expect(r.exitCode, url).toBe(1);
      expect(r.stderr, url).toMatch(pattern);
    }
    const journal = await readJson(JournalSchema, path.join(session, 'journal.json'));
    // nothing navigated and no step was added: what was asked for is journalled as a refusal
    expect(journal.steps).toEqual(before.steps);
    expect(journal.refusals.map((x) => x.url)).toEqual([
      'file:///etc/passwd',
      'http://example.com/',
    ]);
    expect(journal.refusals[1]!.reason).toMatch(/may only open/);
    const still = await site('snapshot');
    expect(still.exitCode, still.stderr).toBe(0);
    expect(still.stdout).toContain(`url: ${server.url}/`);
  }, 120_000);

  it('refuses a click that leaves the allowed hosts, takes the page back, and journals it', async () => {
    // two origins of this machine's own: a page with one link to another page of its site and
    // one to a second server, which is another host (the port is part of it)
    const homeDir = path.join(work, 'linked-site');
    const awayDir = path.join(work, 'away-site');
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(awayDir, { recursive: true });
    await fs.writeFile(
      path.join(awayDir, 'index.html'),
      '<!doctype html><html><head><title>Partner</title></head><body><h1>Partner</h1></body></html>\n',
    );
    const away = await serveStatic(awayDir);
    const home = await serveStatic(homeDir);
    try {
      await fs.writeFile(
        path.join(homeDir, 'index.html'),
        `<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1>\n<a href="/second.html">Second page</a>\n<a href="${away.url}/">Partner</a>\n</body></html>\n`,
      );
      await fs.writeFile(
        path.join(homeDir, 'second.html'),
        '<!doctype html><html><head><title>Second</title></head><body><h1>Second</h1></body></html>\n',
      );
      const s = await openSessionDir('session-offsite');
      const run = (...args: string[]) =>
        execa(bin, ['browser', ...args], { env: s.env, reject: false });
      const opened = await run('open', `${home.url}/`);
      expect(opened.exitCode, opened.stderr).toBe(0);

      // the no-op negative: a link on the allowed host is followed and journalled as a step
      const inside = await run('click', '--role', 'link', '--name', 'Second page');
      expect(inside.exitCode, inside.stderr).toBe(0);
      expect(inside.stdout).toContain(`url: ${home.url}/second.html`);
      const walked = await readJson(JournalSchema, path.join(s.dir, 'journal.json'));
      expect(walked.steps.map((x) => x.url)).toEqual([`${home.url}/second.html`]);
      expect(walked.refusals).toEqual([]);

      // the same click one link over takes the page to another host: refused, undone, and the
      // worker told why. every later command would otherwise act on that site with its whole
      // command set, and a state marked there is dropped by the merge without a word
      const back = await run('open', `${home.url}/`);
      expect(back.exitCode, back.stderr).toBe(0);
      const left = await run('click', '--role', 'link', '--name', 'Partner');
      expect(left.exitCode).toBe(1);
      expect(left.stderr).toMatch(/may only open/);
      expect(left.stderr).toContain(away.url);
      const journal = await readJson(JournalSchema, path.join(s.dir, 'journal.json'));
      expect(journal.steps).toEqual([]);
      expect(journal.refusals.map((x) => x.url)).toEqual([`${away.url}/`]);
      expect(journal.refusals[0]!.reason).toMatch(/may only open/);
      // the page is the one it was on before the click, not the partner's
      expect(left.stdout).toContain(`url: ${home.url}/`);
      const still = await run('snapshot');
      expect(still.exitCode, still.stderr).toBe(0);
      expect(still.stdout).toContain(`url: ${home.url}/`);
      expect((await run('close')).exitCode).toBe(0);
    } finally {
      await home.close();
      await away.close();
    }
  }, 180_000);

  it('refuses every open once the allow list on record cannot be read', async () => {
    const s = await openSessionDir('session-damaged');
    const run = (...args: string[]) =>
      execa(bin, ['browser', ...args], { env: s.env, reject: false });
    // the no-op negative: a session with no list yet opens the url it is given and writes the
    // list from its host, and the file is this user's alone
    const first = await run('open', `${server.url}/`);
    expect(first.exitCode, first.stderr).toBe(0);
    const allow = path.join(s.dir, 'allow.json');
    expect((await fs.stat(allow)).mode & 0o777).toBe(0o600);
    expect(await readJson(AllowHostsSchema, allow)).toEqual([new URL(server.url).host]);
    expect((await run('close')).exitCode).toBe(0);
    // a guard that cannot read its own record opens nothing until a person looks at it: the
    // fallback that used to apply here was the host of the url being asked for
    await fs.writeFile(allow, '{');
    const refused = await run('open', `${server.url}/`);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(allow);
  }, 180_000);

  it('stays up while the process that owns the session is there, and goes when it is not', async () => {
    // the keeper's own parent is `site browser open`, which exits as soon as the browser is up,
    // so the owner is whoever asked for the session: the orchestrator running exploreAgent, or
    // the shell a person typed the command in. a SIGKILL of the run leaves no cleanup, and
    // without this the chromium sits there until DRIVER.idleMs (20 minutes) runs out
    const alive = await openSessionDir('session-owner-alive');
    const record = await openBrowser({
      site: bin,
      sessionDir: alive.dir,
      url: `${server.url}/`,
      viewport: 'desktop',
    });
    // the no-op negative: this process opened it and is still here, so the keeper stays up
    // across two poll intervals and answers commands after them
    expect(record.ownerPid).toBe(process.pid);
    await sleep(2 * DRIVER.pollMs + 1_000);
    expect(processAlive(record.pid)).toBe(true);
    const still = await execa(bin, ['browser', 'snapshot'], { env: alive.env, reject: false });
    expect(still.exitCode, still.stderr).toBe(0);
    expect(still.stdout).toContain(`url: ${server.url}/`);
    expect(await closeBrowser(alive.dir)).toBe(true);

    // and the same keeper started by a process that goes away: openBrowser runs in a short
    // lived node, which exits as soon as the browser is up
    const gone = await openSessionDir('session-owner-gone');
    const loader = path.resolve('node_modules/tsx/dist/loader.mjs');
    const script = `import(${JSON.stringify(path.resolve('src/orchestrate/explorer.ts'))}).then((m) => m.openBrowser({ site: ${JSON.stringify(bin)}, sessionDir: ${JSON.stringify(gone.dir)}, url: ${JSON.stringify(`${server.url}/`)}, viewport: 'desktop' }))`;
    const running = execa(process.execPath, ['--import', loader, '-e', script], {
      env: gone.env,
      reject: false,
    });
    const ownerPid = running.pid!;
    const owner = await running;
    expect(owner.exitCode, owner.stderr).toBe(0);
    const left = await readJson(BrowserSessionSchema, path.join(gone.dir, 'browser.json'));
    expect(left.ownerPid).toBe(ownerPid);
    expect(processAlive(left.ownerPid)).toBe(false);
    // the chromium the keeper launched is its child; it must go with it
    const kids = await execa('pgrep', ['-P', String(left.pid)], { reject: false });
    const chromium = kids.stdout
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    expect(chromium.length).toBeGreaterThan(0);
    const until = Date.now() + DRIVER.pollMs + 15_000;
    while (processAlive(left.pid) && Date.now() < until) await sleep(200);
    expect(processAlive(left.pid), 'the keeper outlived its owner').toBe(false);
    // it closed itself down rather than being killed: the session file is gone with it
    await expect(fs.stat(path.join(gone.dir, 'browser.json'))).rejects.toThrow(/ENOENT/);
    for (const pid of chromium) expect(processAlive(pid), `chromium ${pid}`).toBe(false);
  }, 180_000);

  it('takes the owner a run named in the environment over the shell that ran the open', async () => {
    // a worker's own `site browser open` (its brief tells it to reopen the page after every
    // state it marks) runs in whatever shell the binary's Bash tool gives it, and that shell
    // may not outlive the command. the orchestrator names itself instead, through the same
    // environment it names the session dir in, which the worker cannot redirect
    const open = (dir: string, env: NodeJS.ProcessEnv) =>
      // `; echo` so sh forks the cli rather than exec'ing into it: the point of the test is a
      // shell process that exits while the keeper stays
      execa('sh', ['-c', `'${bin}' browser open '${server.url}/' > /dev/null; echo opened`], {
        env: { ...env, SITE_BROWSER_SESSION: dir },
        reject: false,
      });

    // the no-op negative: with no owner named, the shell that ran the open owns the session,
    // and the keeper goes when that shell does
    const shell = await openSessionDir('session-owner-shell');
    const first = await open(shell.dir, env);
    expect(first.exitCode, first.stderr).toBe(0);
    const byShell = await readJson(BrowserSessionSchema, path.join(shell.dir, 'browser.json'));
    expect(byShell.ownerPid).not.toBe(process.pid);
    expect(processAlive(byShell.ownerPid)).toBe(false);
    const gone = Date.now() + DRIVER.pollMs + 15_000;
    while (processAlive(byShell.pid) && Date.now() < gone) await sleep(200);
    expect(processAlive(byShell.pid), 'the keeper outlived the shell that owned it').toBe(false);

    // named: this process owns it, and the keeper stays up after its shell is long gone
    const named = await openSessionDir('session-owner-named');
    const second = await open(named.dir, { ...env, SITE_BROWSER_OWNER: String(process.pid) });
    expect(second.exitCode, second.stderr).toBe(0);
    const record = await readJson(BrowserSessionSchema, path.join(named.dir, 'browser.json'));
    expect(record.ownerPid).toBe(process.pid);
    await sleep(2 * DRIVER.pollMs + 1_000);
    expect(processAlive(record.pid)).toBe(true);
    const still = await execa(bin, ['browser', 'snapshot'], { env: named.env, reject: false });
    expect(still.exitCode, still.stderr).toBe(0);
    expect(still.stdout).toContain(`url: ${server.url}/`);
    expect(await closeBrowser(named.dir)).toBe(true);
    // a value that is not a pid is no value at all: the shell owns it again
    const bad = await openSessionDir('session-owner-bad');
    const third = await open(bad.dir, { ...env, SITE_BROWSER_OWNER: 'not-a-pid' });
    expect(third.exitCode, third.stderr).toBe(0);
    const fallback = await readJson(BrowserSessionSchema, path.join(bad.dir, 'browser.json'));
    expect(fallback.ownerPid).not.toBe(process.pid);
    expect(await closeBrowser(bad.dir)).toBe(true);
  }, 180_000);

  it('leaves a deaf record alone when its pid is not a keeper of this session', async () => {
    const dir = path.join(work, 'deaf');
    await fs.mkdir(dir, { recursive: true });
    // the no-op negative: with no record at all there is nothing to close and nothing to signal
    expect(await closeBrowser(dir)).toBe(false);
    // a pid on macos comes round again inside a day, so a record this recent can still name
    // somebody else's process: this one names a plain node that is not a keeper at all
    const other = execa(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { reject: false });
    const pid = other.pid!;
    try {
      await writeJson(path.join(dir, 'browser.json'), {
        endpoint: 'http://127.0.0.1:1/',
        pid,
        ownerPid: process.pid,
        startedAt: new Date().toISOString(),
        url: `${server.url}/`,
        viewport: 'desktop',
        token: 'f'.repeat(64),
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        expect(await closeBrowser(dir)).toBe(true);
        expect(String(warn.mock.calls[0]?.[0] ?? '')).toMatch(/is not a browser keeper/);
      } finally {
        warn.mockRestore();
      }
      expect(processAlive(pid)).toBe(true);
      await expect(fs.stat(path.join(dir, 'browser.json'))).rejects.toThrow();
    } finally {
      other.kill('SIGKILL');
      await other.catch(() => undefined);
    }
  }, 60_000);

  it('reads a candidates file it cannot parse as nothing marked, with a note', async () => {
    // the no-op negative: the session's own file, written by the tool, reads back as it was
    const marked = await readCandidates(session);
    expect(marked.states.map((s) => s.name)).toEqual(['modal-talk-to-us']);
    const half = path.join(work, 'half-written');
    await fs.mkdir(half, { recursive: true });
    await fs.writeFile(path.join(half, 'candidates.json'), '{"states":[{"url":"http');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // a worker killed mid-write costs its own page's candidates and must not throw the
      // merge loop that was about to read every other page's
      expect(await readCandidates(half)).toEqual({ states: [], flows: [] });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/candidates\.json: ignored/);
    } finally {
      warn.mockRestore();
    }
    // a dir with no file at all is empty and says nothing
    const empty = path.join(work, 'nothing-marked');
    await fs.mkdir(empty, { recursive: true });
    expect(await readCandidates(empty)).toEqual({ states: [], flows: [] });
  });

  it('opens again from rest at another viewport, keeps the candidates, and closes the keeper', async () => {
    const before = await readJson(BrowserSessionSchema, path.join(session, 'browser.json'));
    const again = await site('open', `${server.url}/`, '--viewport', 'mobile');
    expect(again.exitCode, again.stderr).toBe(0);
    expect(again.stdout).toContain('dialog: none');
    // the hamburger is shown at phone width only: the fixture's mobile-only state
    expect(again.stdout).toMatch(/menu\s+button "Menu"/);
    // the keeper before was closed by the open
    expect(processAlive(before.pid)).toBe(false);
    const journal = await readJson(JournalSchema, path.join(session, 'journal.json'));
    // a fresh journal: the steps and the refusals of the session before are gone with it
    expect(journal).toEqual({
      url: `${server.url}/`,
      viewport: 'mobile',
      steps: [],
      refusals: [],
    });
    const candidates = await readJson(CandidatesSchema, path.join(session, 'candidates.json'));
    expect(candidates.states.map((s) => s.name)).toEqual(['modal-talk-to-us']);
    // one policy with browser.json: what this session may open, what it did and what it marked
    // are this user's alone, whatever the mode of the dir they sit in
    for (const name of ['allow.json', 'journal.json', 'candidates.json']) {
      expect((await fs.stat(path.join(session, name))).mode & 0o777, name).toBe(0o600);
    }
    const record = await readJson(BrowserSessionSchema, path.join(session, 'browser.json'));
    const closed = await site('close');
    expect(closed.exitCode, closed.stderr).toBe(0);
    expect(closed.stdout.trim()).toBe('closed');
    await expect(fs.stat(path.join(session, 'browser.json'))).rejects.toThrow();
    const until = Date.now() + 10_000;
    while (processAlive(record.pid) && Date.now() < until) await sleep(100);
    expect(processAlive(record.pid)).toBe(false);
    expect((await site('close')).stdout.trim()).toBe('no browser was open');
    expect((await site('snapshot')).exitCode).toBe(1);
  }, 120_000);
});
