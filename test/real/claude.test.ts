/**
 * the milestone's proof, on the real binary. gated on SITE_REAL_CLAUDE=1 and run through
 * `npm run test:real`, never by `npm test`: every run spends turns of the subscription window.
 * one run of everything: the fixture index captured, scaffolded, and rebuilt by real builder
 * and reviewer workers until every unit passes; a reviewer handed a build that verify passed
 * but a person would not; an explorer driving the fixture.
 *
 * models: the builder is `sonnet`, because the hero has to land under 0.1 percent mismatch
 * with every computed style exact and every keyframe by name, and that is an edit loop of a
 * dozen turns with images in the context; the reviewer and the explorer are `haiku`, because
 * each is a look and a short answer, haiku reads images, and it is the cheapest on the window.
 * cost is turns on the window, not money.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../helpers/serve';
import { installCached } from '../helpers/scaffold-cache';
import { openSession, type Session } from '../../src/capture/session';
import { explore } from '../../src/capture/explore';
import { captureAll } from '../../src/capture/capture-all';
import { readCandidates } from '../../src/capture/driver';
import { loadManifest, readJson } from '../../src/pack/io';
import { EXPLORER_FILES, ROUND_FILES, RunPaths } from '../../src/pack/paths';
import { ReviewerOutputSchema, StopHookStateSchema, type Manifest } from '../../src/pack/schemas';
import { reviewerBrief } from '../../src/orchestrate/brief';
import { build } from '../../src/orchestrate/build';
import { REVIEWER_ALLOWED, REVIEWER_TOOLS } from '../../src/orchestrate/defaults';
import { exploreAgent } from '../../src/orchestrate/explorer';
import { siteBin } from '../../src/orchestrate/hooks';
import { formatProject, scaffoldProject } from '../../src/orchestrate/scaffold/scaffold';
import { findResult, runWorker, stripClaudeEnv } from '../../src/orchestrate/worker';
import { verifyUnit } from '../../src/verify/verify';

const REAL = process.env['SITE_REAL_CLAUDE'] === '1';
const MODELS = { builder: 'sonnet', reviewer: 'haiku', explorer: 'haiku' };
const SNAPSHOT = path.resolve('test/fixtures/scaffold/nextjs-app');
const HOUR = 3_600_000;
// bin/site runs `node`; the session variables go, so the run works from inside a session too
const env = stripClaudeEnv({
  ...process.env,
  PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env['PATH'] ?? ''}`,
});

let server: Awaited<ReturnType<typeof serveStatic>>;
let mutated: Awaited<ReturnType<typeof serveStatic>>;
let session: Session;
let work: string;
let root: string;
let project: string;
let manifest: Manifest;
/** the dev server the build started, so the clean-up below can say it is gone */
let devTarget: string | null = null;

describe.skipIf(!REAL)('the real claude', () => {
  beforeAll(async () => {
    // extendEnv is execa's default and would put CLAUDECODE back from process.env for this one
    // spawn: `env` above drops the key rather than setting it undefined
    const version = await execa('claude', ['--version'], { env, extendEnv: false, reject: false });
    if (version.exitCode !== 0) throw new Error(`claude is not on PATH: ${version.stderr}`);
    console.log(`claude ${version.stdout.trim()}; models ${JSON.stringify(MODELS)}`);
    server = await serveStatic(path.resolve('test/fixtures/site'));
    mutated = await serveStatic(path.resolve('test/fixtures/site-mutated'));
    session = await openSession({});
    work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'site-real-')));
    root = path.join(work, 'pack');
    project = path.join(work, 'fixture-co');
    // the index page and its sections, no states: the sections and the page are the proof,
    // a state is the same round over a page's components and is left to the fixture smoke
    await explore({ root, url: `${server.url}/`, depth: 0, scope: [], session, states: false });
    await captureAll({ root, session });
    await scaffoldProject({
      out: project,
      name: 'fixture-co-rebuild',
      source: SNAPSHOT,
      root,
      install: false,
    });
    await installCached(project);
    await formatProject(project, env);
    manifest = await loadManifest(root);
  }, 1_800_000);
  afterAll(async () => {
    await session?.close();
    await server?.close();
    await mutated?.close();
    // nothing this run started outlives it: a browser keeper carries its session dir under the
    // work dir on its command line, `npm run dev` and next carry the port the build chose, and
    // every chromium is a child of one of those or of the session just closed. the pattern names
    // the process kinds, not any command carrying the work path: a shell polling the run's
    // artefacts (a `tail` or an `ls` of the work dir) is a watcher, not a leak
    if (work) {
      const port = devTarget ? new URL(devTarget).port : null;
      const keeper = `browser keep .*${work}`;
      const pattern = port ? `${keeper}|-p ${port} -H 127\\.0\\.0\\.1` : keeper;
      const left = await execa('pgrep', ['-f', pattern], { env, reject: false });
      expect(left.stdout.trim(), `still running after the run: ${pattern}`).toBe('');
    }
    // the pack, the project and the run logs stay on disk for reading; the path is printed
    console.log(`kept for reading: ${work}`);
  });

  it(
    'rebuilds the fixture index with real builders and reviewers until every unit passes',
    async () => {
      const lines: string[] = [];
      const r = await build({
        root,
        project,
        claude: 'claude',
        site: siteBin(),
        parallel: 1,
        rounds: 4,
        models: { builder: MODELS.builder, reviewer: MODELS.reviewer },
        env,
        log: (line) => {
          lines.push(line);
          console.log(line);
        },
      });
      devTarget = r.log.target || null;
      console.log(`run dir: ${new RunPaths(root, r.run).dir}`);
      const ids = Object.keys(manifest.units).sort();
      const table = r.log.rounds.map(
        (x) =>
          `${x.unitId} round ${x.round}: ${x.result}${x.reason ? ` (${x.reason})` : ''}; builder ${x.builder?.outcome} in ${x.builder?.numTurns ?? '?'} turns, ${Math.round((x.builder?.durationMs ?? 0) / 1000)}s, stop ${x.builder?.stopReason ?? '?'}; verify ${x.verify?.verdict ?? '-'} ${x.verify?.score ?? ''}; reviewer ${x.reviewer?.outcome ?? '-'}`,
      );
      console.log(table.join('\n'));
      // the per-round reading comes first: on run 2 the assertions below failed and this loop
      // never ran, so the denials had to be read out of the round dirs by hand afterwards
      for (const round of r.log.rounds) {
        // the builder's structured output parsed every time it finished; a round it did not
        // finish is a retry the table above explains
        if (round.builder?.outcome === 'done') expect(round.builder.output).not.toBeNull();
        // the per-round rules were honoured: no denial names `site verify` or `site shot`, in
        // any spelling the rules cover or the brief forbids
        const raw = await fs.readFile(
          path.join(root, round.dir, ROUND_FILES.builderStdout),
          'utf8',
        );
        const result = findResult(raw);
        const denials = (result?.permission_denials ?? []) as {
          tool_name: string;
          tool_input?: { command?: string };
        }[];
        for (const d of denials) {
          // the anchor is wider than `^`: run 2 also had `cd "<project>" && site verify …` and
          // `/Users/…/bin/site verify …` refused, and both are the brief's problem to prevent
          expect(
            d.tool_input?.command ?? '',
            `${round.unitId} round ${round.round}: the builder was denied its own gate. a quoted spelling means the nine rules verifyRuleFor/shotRuleFor build in src/orchestrate/defaults.ts do not cover what the model typed; a \`cd\`, another spelling of the binary, a moved flag or a pipe means the brief's "exactly as printed" sentence in src/orchestrate/brief.ts did not land. read the command, fix the one that matches it, update worker.test.ts and round.test.ts, and rerun`,
          ).not.toMatch(/(^|&&\s*|;\s*|\|\s*)(\S*\/)?site (verify|shot) /);
        }
        if (round.result !== 'passed') continue;
        expect(round.builder?.outcome).toBe('done');
        expect(round.verify?.verdict).toBe('pass');
        expect(round.reviewer?.output).toMatchObject({ verdict: 'pass' });
        // the inner gate ran: the stop hook wrote its state for the round
        const state = await readJson(
          StopHookStateSchema,
          path.join(root, round.dir, ROUND_FILES.stopState),
        );
        expect(state.lastVerdict === 'pass' || state.blocks > 0).toBe(true);
      }
      expect(r.blocked, `blocked: ${r.blocked.join(', ')}`).toEqual([]);
      expect(r.interrupted).toEqual([]);
      expect(r.passed.sort()).toEqual(ids);
      const passedRounds = r.log.rounds.filter((x) => x.result === 'passed');
      expect(passedRounds).toHaveLength(ids.length);
      const turns = passedRounds.reduce((sum, x) => sum + (x.builder?.numTurns ?? 0), 0);
      console.log(
        `${ids.length} units passed in ${r.log.rounds.length} rounds, ${turns} builder turns`,
      );
    },
    4 * HOUR,
  );

  it(
    'rejects a build that verify passed but a person would not: the features grid with a card missing',
    async () => {
      const unitId = Object.keys(manifest.units).find((id) =>
        id.startsWith('page:index#s03-features'),
      )!;
      const sectionId = unitId.split('#')[1]!;
      const outDir = path.join(work, 'review-wrong');
      // ours is the mutated twin, which drops one of the three cards. the gate is opened wide
      // and the findings emptied so the brief reads as a pass: what is left for the reviewer is
      // the pictures, where two cards stand where the source has three. `structure` is emptied
      // with the rest, and it is the one that matters: left in, the brief's verify block reads
      // `structure item: expected Private by design ..., got (missing)`, and the reviewer could
      // reject by copying that line without ever opening a png
      const v = await verifyUnit({ root, unitId, target: mutated.url, session, outDir, gate: 1 });
      expect(v.pixel.desktop!.score).toBeGreaterThan(0);
      const asPass = {
        ...v,
        verdict: 'pass' as const,
        styles: [],
        animations: [],
        structure: [],
        missing: [],
      };
      const brief = await reviewerBrief({
        root,
        manifest,
        unitId,
        round: 1,
        rounds: 1,
        project,
        target: mutated.url,
        threshold: 1,
        shotsDir: path.join(outDir, 'shots'),
        previous: null,
        verify: asPass,
        builder: {
          summary: 'built the features grid with its three cards',
          filesTouched: [`src/features/index/components/${sectionId}.tsx`],
          notes: '',
        },
      });
      const review = await runWorker({
        role: 'reviewer',
        claude: 'claude',
        cwd: project,
        brief,
        maxTurns: 12,
        timeoutMs: 8 * 60_000,
        tools: REVIEWER_TOOLS,
        allowedTools: REVIEWER_ALLOWED,
        settingsFile: null,
        addDirs: [root],
        schema: ReviewerOutputSchema,
        outDir,
        files: {
          brief: 'review-brief.md',
          stdout: 'reviewer.stdout.txt',
          stderr: 'reviewer.stderr.txt',
          record: 'reviewer.json',
        },
        env,
        model: MODELS.reviewer,
      });
      console.log(`reviewer ${review.outcome} in ${review.record.numTurns} turns:`, review.output);
      expect(review.outcome).toBe('done');
      expect(review.output).toMatchObject({ verdict: 'reject' });
      expect(review.output!.reasons.length).toBeGreaterThan(0);
      expect(review.output!.reasons.join(' ')).toMatch(
        /card|item|private by design|three|two|missing/i,
      );
    },
    HOUR,
  );

  it(
    'explores the fixture with a real worker, which never fills the email field',
    async () => {
      const root2 = path.join(work, 'pack-explore');
      await explore({
        root: root2,
        url: `${server.url}/`,
        depth: 0,
        scope: [],
        session,
        states: false,
      });
      const r = await exploreAgent({
        root: root2,
        claude: 'claude',
        site: siteBin(),
        model: MODELS.explorer,
        env,
        log: (line) => console.log(line),
      });
      console.log(r);
      expect(r.outcomes['page:index']).toBe('done');
      // haiku on a page with a hover menu, a click menu, three accordions and a modal with a
      // form: something was marked or asked
      expect(r.states.length + r.flows.length + r.questions.length).toBeGreaterThan(0);
      // the tool's guarantee, whatever the model did: a journaled input on the email field
      // carries no value and names the input
      const sessionDir = path.join(
        new RunPaths(root2, r.run).unitDir('page:index'),
        EXPLORER_FILES.session,
      );
      const c = await readCandidates(sessionDir);
      for (const step of c.flows.flatMap((f) => f.steps)) {
        if (step.kind !== 'input') continue;
        if (/email/i.test(step.target?.role?.name ?? '') || /email/i.test(step.target?.css ?? '')) {
          expect(step.value).toBeNull();
          expect(step.input).toBe('email');
        }
      }
      const m = await loadManifest(root2);
      for (const id of r.states) expect(m.units[id]!.status).toBe('planned');
      await expect(fs.stat(path.join(sessionDir, 'browser.json'))).rejects.toThrow();
    },
    HOUR,
  );
});
