import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../helpers/serve';
import { openSession, type Session } from '../../src/capture/session';
import { explore } from '../../src/capture/explore';
import { captureAll } from '../../src/capture/capture-all';
import { loadManifest, readJson } from '../../src/pack/io';
import { PackPaths, RunPaths } from '../../src/pack/paths';
import { StepsFileSchema, type Candidates } from '../../src/pack/schemas';
import { exploreAgent, mergeExplorer } from '../../src/orchestrate/explorer';
import { siteBin } from '../../src/orchestrate/hooks';
import { childEnv, FAKE_CLAUDE, readScenarioState, writeScenario } from '../helpers/fake-claude';

const bin = path.resolve('bin/site');
let server: Awaited<ReturnType<typeof serveStatic>>;
let session: Session;
let work: string;
const AT = '2026-09-19T00:00:00.000Z';

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  session = await openSession({});
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'site-explorer-'));
});
afterAll(async () => {
  // the cleanup runs first, all of it, so a failure of the assertion after it cannot leak a
  // keeper: every keeper a run opened is closed again, on the crash path too, and one left
  // running holds a chromium for ever. scoped to this file's work dir, so another run is not ours
  await session.close();
  await server.close();
  await fs.rm(work, { recursive: true, force: true });
  const left = await execa('pgrep', ['-f', `browser keep .*${work}`], { reject: false });
  expect(left.stdout.trim()).toBe('');
});

/** what the tool would have journaled for a worker that opened the modal and reached the email field */
function candidates(): Candidates {
  const click = {
    kind: 'click' as const,
    target: {
      role: { role: 'button', name: 'Talk to us' },
      text: 'Talk to us',
      css: '#open-modal',
    },
    value: null,
    input: null,
    scroll: null,
  };
  const email = {
    kind: 'input' as const,
    target: { role: { role: 'textbox', name: 'Email' }, text: null, css: '#modal input' },
    value: null,
    input: 'email',
    scroll: null,
  };
  const url = `${server.url}/`;
  return {
    states: [{ url, name: 'modal-talk-to-us', viewport: 'desktop', actions: [click] }],
    flows: [
      {
        name: 'contact',
        start: url,
        steps: [
          { ...click, n: 1, url, at: AT },
          { ...email, n: 2, url, at: AT },
        ],
        inputs: ['email'],
      },
    ],
  };
}

describe('the explorer worker', () => {
  it('runs one worker per page and plans what its browser recorded, never what it claims', async () => {
    const root = path.join(work, 'agent', 'pack');
    await explore({ root, url: `${server.url}/`, depth: 0, scope: [], session, states: false });
    // the fake writes the session files a real worker's tool calls would have; its answer
    // carries a question and nothing else the plan reads
    const scenarioFile = await writeScenario(path.join(work, 'agent', 'scenario.json'), {
      calls: [
        {
          when: { role: 'explorer' },
          do: {
            writeFiles: { 'candidates.json': JSON.stringify(candidates()) },
            output: {
              summary: 'a modal and a contact form',
              questions: ['the contact form asks for an email; is a test address fine?'],
            },
          },
        },
      ],
    });
    const lines: string[] = [];
    const r = await exploreAgent({
      root,
      claude: FAKE_CLAUDE,
      site: siteBin(),
      model: 'haiku',
      env: childEnv(scenarioFile),
      log: (l) => {
        lines.push(l);
      },
    });
    expect(r.outcomes).toEqual({ 'page:index': 'done' });
    expect(r.states).toEqual(['state:index/modal-talk-to-us']);
    expect(r.flows).toEqual(['contact']);
    expect(r.questions).toEqual(['q-explorer-page_index-1']);
    const m = await loadManifest(root);
    expect(m.units['state:index/modal-talk-to-us']).toMatchObject({
      kind: 'state',
      status: 'planned',
      url: `${server.url}/`,
      dependsOn: ['page:index'],
      reachable: ['desktop'],
    });
    expect(m.flows['contact']).toEqual({ steps: [], inputs: { email: null } });
    expect(m.questions.map((q) => q.id)).toEqual([
      'flow:contact:input:email',
      'q-explorer-page_index-1',
    ]);
    expect(m.questions[1]!.text).toContain('page:index: the contact form asks for an email');
    const steps = await readJson(StepsFileSchema, new PackPaths(root).stepsFile('contact'));
    expect(steps.flow).toBe('contact');
    expect(steps.steps).toHaveLength(2);
    // the worker was launched with Bash alone, allowed on `site browser` only, its cwd the
    // session dir the tool writes into, and the model it was asked for
    const call = (await readScenarioState(scenarioFile)).calls[0]!;
    expect(call.role).toBe('explorer');
    expect(call.argv[call.argv.indexOf('--tools') + 1]).toBe('Bash');
    expect(call.argv[call.argv.indexOf('--allowedTools') + 1]).toBe('Bash(site browser *)');
    expect(call.argv[call.argv.indexOf('--model') + 1]).toBe('haiku');
    expect(call.argv).not.toContain('--settings');
    const run = new RunPaths(root, r.run);
    expect(call.cwd).toBe(await fs.realpath(path.join(run.unitDir('page:index'), 'session')));
    // the session dir and the owner both reach the worker through the environment, which it
    // cannot redirect: every `site browser open` it runs itself lands on this session and
    // belongs to this process, not to the shell the binary ran the command in
    expect(call.env['SITE_BROWSER_SESSION']).toBe(path.join(run.unitDir('page:index'), 'session'));
    expect(call.env['SITE_BROWSER_OWNER']).toBe(String(process.pid));
    // the browser the run opened for it is closed again, and the brief names the tool
    await expect(fs.stat(path.join(call.cwd, 'browser.json'))).rejects.toThrow();
    await expect(fs.stat(path.join(call.cwd, 'journal.json'))).resolves.toBeTruthy();
    const brief = await fs.readFile(path.join(run.unitDir('page:index'), 'brief.md'), 'utf8');
    expect(brief).toContain('role=explorer');
    expect(brief).toContain('site browser state <name>');
    expect(brief).toContain('never fill a field');
    // the tool refuses a password, an email, a card and a one-time code, and nothing else: it
    // cannot tell that a field asks for a name or an address, so the brief must not promise it
    // can, and must say what to do instead
    expect(brief).toContain('before you submit any form that collects one');
    expect(brief).toContain('never submit such a form yourself');
    expect(brief).not.toMatch(/refuses[^.]*\b(name|address|phone)\b/);
    expect(lines.some((l) => l.includes('page:index: 1 states, 1 flows, 1 questions'))).toBe(true);
    // a planned state is captured like the crawler's: its journaled click replays
    const captured = await captureAll({ root, session, only: 'state:index/modal-talk-to-us' });
    expect(captured.captured).toEqual(['state:index/modal-talk-to-us']);
  }, 600_000);

  it('merges nothing from an empty session, and never plans a state or a flow twice', async () => {
    const root = path.join(work, 'merge', 'pack');
    await explore({ root, url: `${server.url}/`, depth: 0, scope: [], session, states: false });
    const m = await loadManifest(root);
    const before = JSON.stringify(m);
    // the no-op negative
    expect(await mergeExplorer(root, m, 'page:index', { states: [], flows: [] }, null)).toEqual({
      states: [],
      flows: [],
      questions: [],
    });
    expect(JSON.stringify(m)).toBe(before);
    const first = await mergeExplorer(root, m, 'page:index', candidates(), null, AT);
    expect(first.states).toEqual(['state:index/modal-talk-to-us']);
    expect(first.flows).toEqual(['contact']);
    // the same again: known state, known flow, nothing added, the steps file untouched
    const stepsFile = new PackPaths(root).stepsFile('contact');
    const written = await fs.readFile(stepsFile, 'utf8');
    const again = await mergeExplorer(root, m, 'page:index', candidates(), null, AT);
    expect(again).toEqual({ states: [], flows: [], questions: [] });
    expect(await fs.readFile(stepsFile, 'utf8')).toBe(written);
    expect(m.questions).toHaveLength(1);
    // a state on a url no page has, an empty state, a bad name: none of them is a unit
    const odd: Candidates = {
      states: [
        { ...candidates().states[0]!, url: `${server.url}/nowhere.html`, name: 'menu-open' },
        { ...candidates().states[0]!, name: 'nothing', actions: [] },
        { ...candidates().states[0]!, name: 'Bad Name' },
      ],
      flows: [{ ...candidates().flows[0]!, name: 'Bad Flow' }],
    };
    expect(await mergeExplorer(root, m, 'page:index', odd, null, AT)).toEqual({
      states: [],
      flows: [],
      questions: [],
    });
    expect(Object.keys(m.units).filter((id) => id.startsWith('state:'))).toEqual([
      'state:index/modal-talk-to-us',
    ]);
    // a worker's own question is one question however often it is asked, the way an input
    // question is: the same page explored again must not pile the same note up
    const asked = { summary: 's', questions: ['who answers the contact form?'] };
    const once = await mergeExplorer(root, m, 'page:index', { states: [], flows: [] }, asked, AT);
    expect(once.questions).toEqual(['q-explorer-page_index-1']);
    const twice = await mergeExplorer(root, m, 'page:index', { states: [], flows: [] }, asked, AT);
    expect(twice.questions).toEqual([]);
    expect(m.questions.filter((q) => q.id.startsWith('q-explorer-'))).toHaveLength(1);
  }, 120_000);

  it('keeps what the browser recorded when the worker itself crashes, and says so', async () => {
    const root = path.join(work, 'crash', 'pack');
    await explore({ root, url: `${server.url}/`, depth: 0, scope: [], session, states: false });
    const scenarioFile = await writeScenario(path.join(work, 'crash', 'scenario.json'), {
      calls: [
        {
          when: { role: 'explorer' },
          do: {
            writeFiles: { 'candidates.json': JSON.stringify(candidates()) },
            stdout: 'boom\n',
            exitCode: 1,
          },
        },
      ],
    });
    const lines: string[] = [];
    const r = await exploreAgent({
      root,
      claude: FAKE_CLAUDE,
      site: siteBin(),
      env: childEnv(scenarioFile),
      log: (l) => {
        lines.push(l);
      },
    });
    expect(r.outcomes).toEqual({ 'page:index': 'crashed' });
    expect(r.states).toEqual(['state:index/modal-talk-to-us']);
    expect(r.flows).toEqual(['contact']);
    expect(r.questions).toEqual([]);
    expect(lines.some((l) => l.includes('page:index: explorer crashed'))).toBe(true);
    const m = await loadManifest(root);
    expect(m.units['state:index/modal-talk-to-us']!.status).toBe('planned');
  }, 300_000);

  it('runs through `site explore --agent`, after the crawl, under the pack lock', async () => {
    const root = path.join(work, 'cli', 'pack');
    const scenarioFile = await writeScenario(path.join(work, 'cli', 'scenario.json'), {
      calls: [
        {
          when: { role: 'explorer' },
          times: 10,
          do: {
            writeFiles: { 'candidates.json': JSON.stringify(candidates()) },
            output: { summary: 's', questions: [] },
          },
        },
      ],
    });
    // the crawl's own discovery finds the modal first, so the worker's copy of it is not
    // planned twice; the flow is new
    const r = await execa(
      bin,
      [
        'explore',
        `${server.url}/`,
        '--out',
        root,
        '--depth',
        '0',
        '--agent',
        '--claude',
        FAKE_CLAUDE,
      ],
      { env: childEnv(scenarioFile), reject: false },
    );
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain('explorer: 0 states, 1 flows, 0 questions');
    const m = await loadManifest(root);
    expect(Object.keys(m.units).filter((id) => id === 'state:index/modal-talk-to-us')).toHaveLength(
      1,
    );
    expect(m.flows['contact']).toEqual({ steps: [], inputs: { email: null } });
    await expect(fs.stat(path.join(root, 'runs', '.lock'))).rejects.toThrow();
    const refused = await execa(
      bin,
      ['explore', `${server.url}/`, '--out', root, '--agent', '--attach', 'http://127.0.0.1:9'],
      { env: childEnv(scenarioFile), reject: false },
    );
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toMatch(/--agent/);
  }, 600_000);
});
