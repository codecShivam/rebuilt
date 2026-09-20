import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  slugFromUrl,
  sectionIdFor,
  refFromPath,
  unitIdForPage,
  unitIdForSection,
  unitIdForState,
  unitIdForFlowStep,
  stepSlug,
  parseUnitId,
  FLOW_NAME,
} from '../../src/pack/ids';
import {
  readJson,
  writeJson,
  writeDirAtomic,
  newManifest,
  saveManifest,
  loadManifest,
} from '../../src/pack/io';
import {
  AnimationsFileSchema,
  BrowserSessionSchema,
  CandidatesSchema,
  ClaudeResultSchema,
  DriverCommandSchema,
  ExplorerOutputSchema,
  FrameReportSchema,
  HookSettingsSchema,
  JournalSchema,
  LockFileSchema,
  ManifestSchema,
  MotionInfoSchema,
  ReviewerOutputSchema,
  RoundRecordSchema,
  RunLogSchema,
  ScenarioSchema,
  StepsFileSchema,
  UnitRecordSchema,
  WorkerOutputSchema,
  WorkerRunSchema,
} from '../../src/pack/schemas';
import { PackPaths, ROUND_FILES, RunPaths, safeUnitName } from '../../src/pack/paths';
import { blockUnit, HINTS } from '../../src/pack/units';
import { ERROR_CODES } from '../../src/pack/defaults';

describe('ids', () => {
  it('slugs a url path', () => {
    expect(slugFromUrl('https://x.com/')).toBe('index');
    expect(slugFromUrl('https://x.com/pricing/')).toBe('pricing');
    expect(slugFromUrl('https://x.com/blog/hello-world?utm=1#top')).toBe('blog--hello-world');
  });
  it('builds a section id', () => {
    expect(sectionIdFor(3, 'features', 'Everything you need!')).toBe(
      's03-features-everything-you-need',
    );
    expect(sectionIdFor(1, 'header', '')).toBe('s01-header');
  });
  it('derives a stable ref from a path', () => {
    const a = refFromPath('body>div:nth-of-type(2)>section:nth-of-type(1)>h2');
    expect(a).toMatch(/^r[0-9a-f]{8}$/);
    expect(refFromPath('body>div:nth-of-type(2)>section:nth-of-type(1)>h2')).toBe(a);
    expect(refFromPath('body>div:nth-of-type(1)')).not.toBe(a);
  });
  it('round-trips unit ids', () => {
    const page = unitIdForPage('pricing');
    expect(page).toBe('page:pricing');
    const section = unitIdForSection(page, 's02-hero');
    expect(section).toBe('page:pricing#s02-hero');
    expect(parseUnitId(section)).toEqual({
      kind: 'section',
      slug: 'pricing',
      sectionId: 's02-hero',
      parent: 'page:pricing',
    });
    expect(parseUnitId(page)).toEqual({ kind: 'page', slug: 'pricing' });
  });
  it('builds and parses state and flow step ids', () => {
    expect(unitIdForState('index', 'modal-talk-to-us')).toBe('state:index/modal-talk-to-us');
    expect(parseUnitId('state:index/modal-talk-to-us')).toEqual({
      kind: 'state',
      slug: 'index',
      state: 'modal-talk-to-us',
    });
    expect(stepSlug(1, 'click', 'Talk to us, please, now!')).toBe(
      'step-01-click-talk-to-us-please',
    );
    expect(stepSlug(12, 'scroll', '')).toBe('step-12-scroll');
    expect(unitIdForFlowStep('signup', 'step-01-click-talk-to-us')).toBe(
      'flow:signup/step-01-click-talk-to-us',
    );
    expect(parseUnitId('flow:signup/step-01-click-talk-to-us')).toEqual({
      kind: 'flowStep',
      flow: 'signup',
      step: 'step-01-click-talk-to-us',
    });
    expect(FLOW_NAME.test('signup-2')).toBe(true);
    expect(FLOW_NAME.test('Sign up')).toBe(false);
  });
  it('caps the heading slug in a section id at 60 characters', () => {
    const long =
      'Supercalifragilisticexpialidocious antidisestablishmentarianism floccinaucinihilipilification';
    const id = sectionIdFor(2, 'hero', long);
    expect(id.startsWith('s02-hero-')).toBe(true);
    expect(id.length).toBeLessThanOrEqual('s02-hero-'.length + 60);
    expect(id.endsWith('-')).toBe(false);
    expect(sectionIdFor(2, 'hero', 'Know before you go')).toBe('s02-hero-know-before-you-go');
  });
  it('rejects a section id with nothing after the hash', () => {
    expect(() => parseUnitId('page:x#')).toThrow(/bad unit id/);
    expect(() => parseUnitId('page:x#a#b')).toThrow(/bad unit id/);
  });
  it('rejects a segment that is not a slug, because every segment becomes a path', () => {
    expect(() => parseUnitId('state:index/..')).toThrow(/bad unit id/);
    expect(() => parseUnitId('flow:../x/step-01-a')).toThrow(/bad unit id/);
    expect(() => parseUnitId('state:a/b/c')).toThrow(/bad unit id/);
    expect(() => parseUnitId('page:../../etc')).toThrow(/bad unit id/);
    expect(() => parseUnitId('page:x#../y')).toThrow(/bad unit id/);
    expect(() => parseUnitId('state:Index/Open')).toThrow(/bad unit id/);
  });
});

describe('paths', () => {
  it('resolves state, flow step and steps file paths', () => {
    const p = new PackPaths('/packs/x');
    expect(p.unitDir('state:index/modal-talk-to-us')).toBe(
      path.join('/packs/x', 'pages', 'index', 'states', 'modal-talk-to-us'),
    );
    expect(p.unitDir('flow:signup/step-01-click-talk-to-us')).toBe(
      path.join('/packs/x', 'flows', 'signup', 'step-01-click-talk-to-us'),
    );
    expect(p.stepsFile('signup')).toBe(path.join('/packs/x', 'steps', 'signup.json'));
  });

  it('resolves run, round and lock paths from a unit id made safe for a file name', () => {
    expect(safeUnitName('page:index#s02-hero-x')).toBe('page_index_s02-hero-x');
    expect(safeUnitName('flow:signup/step-01-click')).toBe('flow_signup_step-01-click');
    const p = new PackPaths('/packs/x');
    expect(p.runsDir).toBe(path.join('/packs/x', 'runs'));
    expect(p.lock).toBe(path.join('/packs/x', 'runs', '.lock'));
    const run = new RunPaths('/packs/x', '2026-09-18T10-00-00');
    expect(run.dir).toBe(path.join('/packs/x', 'runs', '2026-09-18T10-00-00'));
    expect(run.log).toBe(path.join(run.dir, 'run.json'));
    expect(run.report).toBe(path.join(run.dir, 'report.md'));
    expect(run.roundDir('page:index#s02-hero-x', 3)).toBe(
      path.join(run.dir, 'page_index_s02-hero-x', 'round-3'),
    );
    expect(ROUND_FILES.brief).toBe('brief.md');
    expect(ROUND_FILES.verify).toBe('verify');
  });
});

describe('schemas', () => {
  it('validates a steps file and a state unit with actions', () => {
    const target = { role: { role: 'button', name: 'Products' }, text: 'Products', css: '#p' };
    const at = '2026-09-18T00:00:00.000Z';
    const step = {
      n: 1,
      kind: 'click',
      target,
      value: null,
      input: null,
      scroll: null,
      url: 'https://x.com/',
      at,
    };
    expect(
      StepsFileSchema.safeParse({
        flow: 'f',
        start: 'https://x.com/',
        recordedAt: at,
        steps: [step],
      }).success,
    ).toBe(true);
    expect(
      StepsFileSchema.safeParse({ flow: 'f', start: 'nope', recordedAt: at, steps: [] }).success,
    ).toBe(false);
    const unit = {
      kind: 'state',
      status: 'planned',
      url: 'https://x.com/',
      dependsOn: ['page:index'],
      rounds: 0,
      updatedAt: at,
      actions: [{ kind: 'hover', target, value: null, input: null, scroll: null }],
    };
    expect(UnitRecordSchema.safeParse(unit).success).toBe(true);
    expect(
      UnitRecordSchema.safeParse({
        ...unit,
        actions: [{ kind: 'jump', target, value: null, input: null, scroll: null }],
      }).success,
    ).toBe(false);
  });
  it('validates the animations file, motion info, a reachable list and a frames report', () => {
    const stop = { offset: '0%', declarations: { opacity: '0' } };
    const observed = {
      id: '1',
      type: 'CSSAnimation',
      name: 'pulse',
      path: 'body>span:nth-of-type(1)',
      ref: 'r1',
      dataRef: null,
      duration: 2000,
      delay: 0,
      iterations: null,
      easing: 'linear',
      keyframeEasings: ['ease-in-out'],
      phase: 'load',
      startedAt: 12,
    };
    const file = {
      keyframes: { fadeIn: { from: 'cssom', stops: [stop] } },
      elements: {
        mobile: {},
        desktop: {
          'body>h1:nth-of-type(1)': {
            ref: 'r2',
            dataRef: null,
            animation: { 'animation-name': 'fadeIn' },
            transition: null,
          },
        },
      },
      observed: { mobile: [], desktop: [observed] },
      unreadableStylesheets: [],
    };
    expect(AnimationsFileSchema.safeParse(file).success).toBe(true);
    expect(AnimationsFileSchema.safeParse({ ...file, observed: [] }).success).toBe(false);
    const motion = {
      video: 'video.webm',
      fps: 30,
      settleAt: 1200,
      segments: [{ name: 'load', start: 0, seconds: 1.2, frames: 45 }],
      framesKept: false,
      note: null,
    };
    expect(MotionInfoSchema.safeParse(motion).success).toBe(true);
    const at = '2026-09-18T00:00:00.000Z';
    const unit = {
      kind: 'state',
      status: 'planned',
      url: 'https://x.com/',
      dependsOn: ['page:index'],
      rounds: 0,
      updatedAt: at,
    };
    expect(UnitRecordSchema.safeParse({ ...unit, reachable: ['mobile'] }).success).toBe(true);
    expect(UnitRecordSchema.safeParse({ ...unit, reachable: ['tablet'] }).success).toBe(false);
    expect(
      FrameReportSchema.safeParse({
        viewport: 'desktop',
        segment: 'load',
        compared: 45,
        meanScore: 0,
        maxScore: 0,
        worstFrame: 0,
        strip: null,
        note: null,
      }).success,
    ).toBe(true);
  });

  it('validates the orchestrator shapes and rejects fewer than two rest shots', () => {
    expect(
      WorkerOutputSchema.safeParse({ summary: 'built', filesTouched: ['a.tsx'], notes: '' })
        .success,
    ).toBe(true);
    expect(WorkerOutputSchema.safeParse({ summary: 'built', notes: '' }).success).toBe(false);
    expect(ReviewerOutputSchema.safeParse({ verdict: 'reject', reasons: ['x'] }).success).toBe(
      true,
    );
    expect(ReviewerOutputSchema.safeParse({ verdict: 'maybe', reasons: [] }).success).toBe(false);
    // claude's own result object carries fields we never read; the schema is loose on purpose
    const probe = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 1,
      result: 'ok',
      session_id: '72463fd6',
      total_cost_usd: 0.057,
      duration_ms: 1882,
      api_error_status: null,
      terminal_reason: 'completed',
      stop_reason: 'end_turn',
      permission_denials: [],
      fast_mode_state: 'off',
      usage: { input_tokens: 10 },
    };
    expect(ClaudeResultSchema.safeParse(probe).success).toBe(true);
    expect(ClaudeResultSchema.safeParse({ ...probe, type: 'assistant' }).success).toBe(false);
    const at = '2026-09-18T00:00:00.000Z';
    const worker = {
      role: 'builder',
      outcome: 'done',
      reason: null,
      exitCode: 0,
      numTurns: 4,
      sessionId: 's',
      costUsd: 0.1,
      stopReason: 'end_turn',
      startedAt: at,
      durationMs: 12,
      output: { summary: 'built', filesTouched: [], notes: '' },
      files: { brief: 'brief.md', stdout: 'builder.stdout.txt', stderr: 'builder.stderr.txt' },
    };
    expect(WorkerRunSchema.safeParse(worker).success).toBe(true);
    const round = {
      unitId: 'page:index#s02-hero',
      round: 1,
      dir: 'runs/r1/page_index_s02-hero/round-1',
      startedAt: at,
      endedAt: at,
      builder: worker,
      checks: [{ name: 'tsc', exitCode: 0, ok: true }],
      verify: {
        verdict: 'pass',
        score: 0,
        file: 'runs/r1/page_index_s02-hero/round-1/verify/verify.json',
      },
      reviewer: { ...worker, role: 'reviewer', output: { verdict: 'pass', reasons: [] } },
      waits: [{ at, ms: 60000, why: 'rate_limited' }],
      result: 'passed',
      reason: null,
    };
    expect(RoundRecordSchema.safeParse(round).success).toBe(true);
    expect(
      RunLogSchema.safeParse({
        run: 'r1',
        root: '/p',
        project: '/b',
        target: 'http://127.0.0.1:3000',
        claude: 'claude',
        options: { parallel: 2, rounds: 6, threshold: null },
        startedAt: at,
        endedAt: null,
        restored: [],
        rounds: [round],
      }).success,
    ).toBe(true);
    expect(LockFileSchema.safeParse({ pid: 1, run: 'r1', startedAt: at }).success).toBe(true);
    expect(
      HookSettingsSchema.safeParse({
        hooks: {
          PreToolUse: [
            { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'x', timeout: 30 }] },
          ],
          Stop: [{ hooks: [{ type: 'command', command: 'y' }] }],
        },
      }).success,
    ).toBe(true);
    expect(
      ScenarioSchema.safeParse({
        calls: [
          {
            when: { role: 'builder' },
            do: { output: { summary: 's', filesTouched: [], notes: '' } },
          },
        ],
      }).success,
    ).toBe(true);
    expect(ScenarioSchema.safeParse({ calls: [{ when: {}, do: { nope: 1 } }] }).success).toBe(
      false,
    );
    const m = newManifest({ host: 'x.com', sourceUrl: 'https://x.com/' });
    expect(ManifestSchema.safeParse(m).success).toBe(true);
    m.capture.dynamicShots = 1;
    expect(ManifestSchema.safeParse(m).success).toBe(false);
    const unit = {
      kind: 'section',
      status: 'blocked',
      dependsOn: [],
      rounds: 6,
      updatedAt: at,
      artefacts: ['/p/runs/r1/x/round-6/verify/verify.json'],
      lastRoundDir: 'runs/r1/x/round-6',
    };
    expect(UnitRecordSchema.safeParse(unit).success).toBe(true);
    expect(
      FrameReportSchema.safeParse({
        viewport: 'desktop',
        segment: 'load',
        compared: 0,
        meanScore: 0,
        maxScore: 0,
        worstFrame: 0,
        strip: null,
        note: 'no source frames',
      }).success,
    ).toBe(true);
  });
  it('validates the explorer shapes: a candidate is the journal, a command is one of three', () => {
    const at = '2026-09-18T00:00:00.000Z';
    const click = {
      kind: 'click',
      target: { role: { role: 'button', name: 'Talk to us' }, text: 'Talk to us', css: '#open' },
      value: null,
      input: null,
      scroll: null,
    };
    expect(
      JournalSchema.safeParse({
        url: 'http://127.0.0.1:1/',
        viewport: 'desktop',
        steps: [{ ...click, n: 1, url: 'http://127.0.0.1:1/', at }],
        refusals: [{ url: 'file:///etc/passwd', reason: 'http and https only', at }],
      }).success,
    ).toBe(true);
    // a session drives one browser, and a command that reaches it carries its token
    const record = {
      endpoint: 'http://127.0.0.1:1/',
      pid: 2,
      ownerPid: 3,
      startedAt: at,
      url: 'http://127.0.0.1:1/',
      viewport: 'desktop',
      token: 'a'.repeat(64),
    };
    expect(BrowserSessionSchema.safeParse(record).success).toBe(true);
    expect(BrowserSessionSchema.safeParse({ ...record, token: '' }).success).toBe(false);
    const { token: _token, ...noToken } = record;
    expect(BrowserSessionSchema.safeParse(noToken).success).toBe(false);
    // the owner is what the keeper polls to know its run is still there, so a record without
    // one is not a session: it would be a browser nothing ever closes
    const { ownerPid: _owner, ...noOwner } = record;
    expect(BrowserSessionSchema.safeParse(noOwner).success).toBe(false);
    expect(BrowserSessionSchema.safeParse({ ...record, ownerPid: 0 }).success).toBe(false);
    expect(
      CandidatesSchema.safeParse({
        states: [
          { url: 'http://127.0.0.1:1/', name: 'modal-open', viewport: 'desktop', actions: [click] },
        ],
        flows: [
          {
            name: 'contact',
            start: 'http://127.0.0.1:1/',
            steps: [{ ...click, n: 1, url: 'http://127.0.0.1:1/', at }],
            inputs: ['email'],
          },
        ],
      }).success,
    ).toBe(true);
    expect(ExplorerOutputSchema.safeParse({ summary: 's', questions: [] }).success).toBe(true);
    expect(ExplorerOutputSchema.safeParse({ summary: 's' }).success).toBe(false);
    expect(DriverCommandSchema.safeParse({ kind: 'snapshot' }).success).toBe(true);
    expect(DriverCommandSchema.safeParse({ kind: 'act', action: click }).success).toBe(true);
    expect(DriverCommandSchema.safeParse({ kind: 'fill', value: 'x' }).success).toBe(false);
  });
});

describe('io', () => {
  it('rejects json that fails its schema with the path and field', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
    const file = path.join(dir, 'manifest.json');
    await writeJson(file, { host: 'x' });
    await expect(readJson(ManifestSchema, file)).rejects.toThrow(/manifest\.json.*sourceUrl/s);
  });
  it('rejects json that fails to parse with the path', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
    const file = path.join(dir, 'manifest.json');
    await fs.writeFile(file, '{not json');
    await expect(readJson(ManifestSchema, file)).rejects.toThrow(/manifest\.json.*invalid json/s);
  });
  it('writes a dir atomically', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
    const final = path.join(dir, 'unit');
    await expect(
      writeDirAtomic(final, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(fs.stat(final)).rejects.toThrow();
    await writeDirAtomic(final, async (tmp) => {
      await fs.writeFile(path.join(tmp, 'a.txt'), 'a');
    });
    expect(await fs.readFile(path.join(final, 'a.txt'), 'utf8')).toBe('a');
  });
  it('replaces an existing dir wholesale and keeps no .old- sibling', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
    const final = path.join(dir, 'unit');
    await writeDirAtomic(final, async (tmp) => {
      await fs.writeFile(path.join(tmp, 'first.txt'), 'first');
    });
    await writeDirAtomic(final, async (tmp) => {
      await fs.writeFile(path.join(tmp, 'second.txt'), 'second');
    });
    expect(await fs.readdir(final)).toEqual(['second.txt']);
    expect((await fs.readdir(dir)).filter((n) => n.includes('.old-'))).toEqual([]);
  });
  it('creates, saves and loads a manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
    const m = newManifest({ host: 'x.com', sourceUrl: 'https://x.com/' });
    await saveManifest(root, m);
    const back = await loadManifest(root);
    expect(back.host).toBe('x.com');
    expect(back.viewports.mobile.width).toBe(390);
    expect(new PackPaths(root).manifest).toBe(path.join(root, 'manifest.json'));
  });
  it('saves the manifest through a rename, leaving no temp file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
    await saveManifest(root, newManifest({ host: 'x.com', sourceUrl: 'https://x.com/' }));
    expect((await fs.readdir(root)).sort()).toEqual(['manifest.json']);
  });
  it('carries a kept subdir across a rewrite', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
    const final = path.join(dir, 'page');
    await writeDirAtomic(final, async (tmp) => {
      await fs.mkdir(path.join(tmp, 'states', 'x'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'states', 'x', 'a.txt'), 'a');
      await fs.writeFile(path.join(tmp, 'meta.json'), '1');
    });
    await writeDirAtomic(
      final,
      async (tmp) => {
        await fs.writeFile(path.join(tmp, 'meta.json'), '2');
      },
      { keep: ['states'] },
    );
    expect(await fs.readFile(path.join(final, 'meta.json'), 'utf8')).toBe('2');
    expect(await fs.readFile(path.join(final, 'states', 'x', 'a.txt'), 'utf8')).toBe('a');
    expect((await fs.readdir(dir)).filter((n) => n.includes('.old-'))).toEqual([]);
  });
  it('refuses to keep a subdir the new build also wrote, and restores the old dir', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
    const final = path.join(dir, 'page');
    await writeDirAtomic(final, async (tmp) => {
      await fs.mkdir(path.join(tmp, 'states', 'a'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'states', 'a', 'x.txt'), 'old');
    });
    await expect(
      writeDirAtomic(
        final,
        async (tmp) => {
          await fs.mkdir(path.join(tmp, 'states', 'b'), { recursive: true });
          await fs.writeFile(path.join(tmp, 'states', 'b', 'y.txt'), 'new');
        },
        { keep: ['states'] },
      ),
    ).rejects.toThrow(/cannot keep states/);
    expect(await fs.readFile(path.join(final, 'states', 'a', 'x.txt'), 'utf8')).toBe('old');
    await expect(fs.stat(path.join(final, 'states', 'b'))).rejects.toThrow();
    const siblings = await fs.readdir(dir);
    expect(siblings.filter((n) => n.includes('.old-'))).toEqual([]);
    expect(siblings.filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
  it('restores an already-merged keep name when a later keep name collides', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
    const final = path.join(dir, 'page');
    await writeDirAtomic(final, async (tmp) => {
      await fs.mkdir(path.join(tmp, 'states', 'a'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'states', 'a', 'x.txt'), 'old-states');
      await fs.mkdir(path.join(tmp, 'flows', 'f1'), { recursive: true });
      await fs.writeFile(path.join(tmp, 'flows', 'f1', 'y.txt'), 'old-flows');
    });
    await expect(
      writeDirAtomic(
        final,
        async (tmp) => {
          await fs.mkdir(path.join(tmp, 'flows', 'f2'), { recursive: true });
          await fs.writeFile(path.join(tmp, 'flows', 'f2', 'z.txt'), 'new-flows');
        },
        { keep: ['states', 'flows'] },
      ),
    ).rejects.toThrow(/cannot keep flows/);
    expect(await fs.readFile(path.join(final, 'states', 'a', 'x.txt'), 'utf8')).toBe('old-states');
    expect(await fs.readFile(path.join(final, 'flows', 'f1', 'y.txt'), 'utf8')).toBe('old-flows');
    await expect(fs.stat(path.join(final, 'flows', 'f2'))).rejects.toThrow();
    const siblings = await fs.readdir(dir);
    expect(siblings.filter((n) => n.includes('.old-'))).toEqual([]);
    expect(siblings.filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it('refuses a pack written by another tool version with a migration message', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pack-'));
    const m = newManifest({ host: 'x.com', sourceUrl: 'https://x.com/' });
    await saveManifest(root, { ...m, toolVersion: '0.1.0' });
    await expect(loadManifest(root)).rejects.toThrow(
      /written by site 0\.1\.0, this is site 0\.2\.0/,
    );
    await saveManifest(root, m);
    expect((await loadManifest(root)).toolVersion).toBe('0.2.0');
  });
});

describe('units', () => {
  it('blocks a unit with one question shape and one open question per unit', () => {
    const m = newManifest({ host: 'x.com', sourceUrl: 'https://x.com/' });
    const at = '2026-09-18T00:00:00.000Z';
    m.units['page:index'] = {
      kind: 'page',
      status: 'captured',
      dependsOn: [],
      rounds: 2,
      updatedAt: at,
    };
    const unit = blockUnit(
      m,
      'page:index',
      {
        code: ERROR_CODES.roundsExhausted,
        message: 'page:index: 2 rounds without a pass.',
        artefacts: ['/a/diff.png'],
      },
      at,
    );
    expect(unit.status).toBe('blocked');
    expect(unit.blockedReason).toBe('rounds_exhausted');
    expect(unit.question).toBe(`page:index: 2 rounds without a pass. ${HINTS['rounds_exhausted']}`);
    expect(unit.artefacts).toEqual(['/a/diff.png']);
    expect(unit.updatedAt).toBe(at);
    expect(m.questions).toEqual([
      { id: 'q-page_index-1', unit: 'page:index', text: unit.question },
    ]);
    // blocking again replaces the open question instead of adding a second one
    blockUnit(
      m,
      'page:index',
      { code: ERROR_CODES.unreachable, message: 'gone', hint: 'look again.' },
      at,
    );
    expect(m.questions).toHaveLength(1);
    expect(m.questions[0]!.text).toBe('page:index: gone. look again.');
    expect(m.units['page:index']!.artefacts).toBeUndefined();
    // an answered question stays; a new block gets a new id
    m.questions[0]!.answer = 'skip it';
    blockUnit(m, 'page:index', { code: ERROR_CODES.dependency, message: 'x' }, at);
    expect(m.questions.map((q) => q.id)).toEqual(['q-page_index-1', 'q-page_index-2']);
    expect(() => blockUnit(m, 'page:nope', { code: 'x', message: 'y' })).toThrow(
      /not in the manifest/,
    );
  });
});
