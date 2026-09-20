import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../helpers/serve';
import { openSession, type Session } from '../../src/capture/session';
import { explore } from '../../src/capture/explore';
import { replayFlow } from '../../src/capture/flows';
import { verifyFlow } from '../../src/verify/flow';
import { verifyUnit } from '../../src/verify/verify';
import { loadManifest, readJson, saveManifest, writeJson } from '../../src/pack/io';
import { PackPaths, UNIT_FILES } from '../../src/pack/paths';
import { PageMetaSchema, StylesFileSchema, type StepsFile } from '../../src/pack/schemas';
import { ERROR_CODES } from '../../src/pack/defaults';

let server: Awaited<ReturnType<typeof serveStatic>>;
let session: Session;
let root: string;

const MODAL_BOX = 'body>div:nth-of-type(1)>div:nth-of-type(1)';

/** a flow as record would write it: open the modal, type an email that was masked. */
function contactFlow(flow: string, start: string): StepsFile {
  const at = '2026-09-18T12:00:00.000Z';
  return {
    flow,
    start,
    recordedAt: at,
    steps: [
      {
        n: 1,
        kind: 'click',
        target: {
          role: { role: 'button', name: 'Talk to us' },
          text: 'Talk to us',
          css: '#open-modal',
        },
        value: null,
        input: null,
        scroll: null,
        url: start,
        at,
      },
      {
        n: 2,
        kind: 'input',
        target: { role: { role: 'textbox', name: 'Email' }, text: null, css: '#modal input' },
        value: null,
        input: 'email',
        scroll: null,
        url: start,
        at,
      },
    ],
  };
}

/** a flow that leaves the page it started on: type a name, press enter, follow a link there. */
function twoPageFlow(flow: string, base: string): StepsFile {
  const at = '2026-09-18T12:00:00.000Z';
  const name = {
    role: { role: 'textbox', name: 'Name' },
    text: null,
    css: '.contact input',
  };
  return {
    flow,
    start: `${base}/app.html`,
    recordedAt: at,
    steps: [
      {
        n: 1,
        kind: 'input',
        target: name,
        value: 'Ada',
        input: null,
        scroll: null,
        url: `${base}/app.html`,
        at,
      },
      {
        n: 2,
        kind: 'keydown',
        target: name,
        value: 'Enter',
        input: null,
        scroll: null,
        url: `${base}/app.html?name=Ada`,
        at,
      },
      {
        n: 3,
        kind: 'click',
        target: { role: { role: 'link', name: 'Fixture Co' }, text: 'Fixture Co', css: '.logo' },
        value: null,
        input: null,
        scroll: null,
        url: `${base}/`,
        at,
      },
    ],
  };
}

/** a flow whose second step names a target the page never had. */
function brokenFlow(flow: string, start: string): StepsFile {
  const at = '2026-09-18T12:00:00.000Z';
  const step = (n: number, role: string, name: string, css: string) => ({
    n,
    kind: 'click' as const,
    target: { role: { role, name }, text: name, css },
    value: null,
    input: null,
    scroll: null,
    url: start,
    at,
  });
  return {
    flow,
    start,
    recordedAt: at,
    steps: [
      step(1, 'button', 'Talk to us', '#open-modal'),
      step(2, 'button', 'Does Not Exist', '#nope'),
      step(3, 'button', 'Close', '#close-modal'),
    ],
  };
}

/** a flow with a scroll on its own between two actions, and a trailing scroll: neither is a unit. */
function scrolledFlow(flow: string, start: string): StepsFile {
  const base = contactFlow(flow, start);
  const at = base.recordedAt;
  const scroll = (n: number, y: number) => ({
    n,
    kind: 'scroll' as const,
    target: null,
    value: null,
    input: null,
    scroll: { x: 0, y },
    url: start,
    at,
  });
  return {
    ...base,
    steps: [base.steps[0]!, scroll(2, 120), { ...base.steps[1]!, n: 3 }, scroll(4, 300)],
  };
}

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  session = await openSession({});
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'site-pack-flow-'));
  await explore({ root, url: `${server.url}/`, depth: 0, scope: [], session, states: false });
  const pack = new PackPaths(root);
  await writeJson(pack.stepsFile('contact'), contactFlow('contact', `${server.url}/`));
  await writeJson(pack.stepsFile('gated'), contactFlow('gated', `${server.url}/`));
  await writeJson(pack.stepsFile('two-page'), twoPageFlow('two-page', server.url));
  await writeJson(pack.stepsFile('broken'), brokenFlow('broken', `${server.url}/`));
  await writeJson(pack.stepsFile('scrolled'), scrolledFlow('scrolled', `${server.url}/`));
  const m = await loadManifest(root);
  m.flows['contact'] = { steps: [], inputs: { email: 'ada@example.com' } };
  m.flows['gated'] = { steps: [], inputs: { email: null } };
  m.flows['scrolled'] = { steps: [], inputs: { email: 'ada@example.com' } };
  await saveManifest(root, m);
});
afterAll(async () => {
  await session.close();
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe('replayFlow', () => {
  it('captures one unit per step, each reached by replaying from the start', async () => {
    const r = await replayFlow({ root, flow: 'contact', session });
    expect(r.captured).toEqual([
      'flow:contact/step-01-click-talk-to-us',
      'flow:contact/step-02-input-email',
    ]);
    const pack = new PackPaths(root);
    const step2 = pack.flowStepDir('contact', 'step-02-input-email');
    expect(pack.unitDir('flow:contact/step-02-input-email')).toBe(step2);
    const meta = await readJson(PageMetaSchema, path.join(step2, UNIT_FILES.meta));
    expect(meta.reachedBy).toBe('replay');
    expect(meta.url).toBe(`${server.url}/`);
    const styles = await readJson(StylesFileSchema, path.join(step2, UNIT_FILES.styles));
    expect(styles.desktop[MODAL_BOX]?.tag).toBe('div');
    expect(styles.mobile[MODAL_BOX]?.tag).toBe('div');
    const m = await loadManifest(root);
    expect(m.flows['contact']).toEqual({ steps: r.captured, inputs: { email: 'ada@example.com' } });
    expect(m.units['flow:contact/step-01-click-talk-to-us']).toMatchObject({
      kind: 'flowStep',
      status: 'captured',
      url: `${server.url}/`,
      dependsOn: [],
    });
    expect(m.units['flow:contact/step-02-input-email']).toMatchObject({
      kind: 'flowStep',
      status: 'captured',
      dependsOn: ['flow:contact/step-01-click-talk-to-us'],
    });
  }, 300_000);

  it('verifies a flow step by replaying on the target, and the whole flow in order', async () => {
    const r = await verifyUnit({
      root,
      unitId: 'flow:contact/step-02-input-email',
      target: server.url,
      session,
    });
    expect(r.verdict).toBe('pass');
    expect(r.pixel.desktop!.score).toBe(0);
    expect(r.pixel.mobile!.score).toBe(0);
    expect(r.missing).toEqual([]);
    const all = await verifyFlow({ root, flow: 'contact', target: server.url, session });
    expect(all.map((x) => x.unitId)).toEqual([
      'flow:contact/step-01-click-talk-to-us',
      'flow:contact/step-02-input-email',
    ]);
    expect(all.map((x) => x.verdict)).toEqual(['pass', 'pass']);
  }, 300_000);

  it('waits for the navigation a step recorded before replaying the next one', async () => {
    const r = await replayFlow({ root, flow: 'two-page', session });
    expect(r.captured).toEqual([
      'flow:two-page/step-01-input-name',
      'flow:two-page/step-02-keydown-name',
      'flow:two-page/step-03-click-fixture-co',
    ]);
    const pack = new PackPaths(root);
    // meta.url is where the walk started; finalUrl is where the replayed steps left it
    const second = await readJson(
      PageMetaSchema,
      path.join(pack.flowStepDir('two-page', 'step-02-keydown-name'), UNIT_FILES.meta),
    );
    expect(second.url).toBe(`${server.url}/app.html`);
    expect(second.finalUrl).toContain('name=Ada');
    const third = await readJson(
      PageMetaSchema,
      path.join(pack.flowStepDir('two-page', 'step-03-click-fixture-co'), UNIT_FILES.meta),
    );
    expect(third.finalUrl).toBe(`${server.url}/`);
    const m = await loadManifest(root);
    expect(m.units['flow:two-page/step-02-keydown-name']!.url).toContain('name=Ada');
    // a step's interaction segment starts at its own action, so a later step's starts later
    const secondPrepare = second.motion.desktop!.segments.find((s) => s.name === 'prepare')!;
    const thirdPrepare = third.motion.desktop!.segments.find((s) => s.name === 'prepare')!;
    expect(secondPrepare.start).toBeGreaterThan(0);
    expect(thirdPrepare.start).toBeGreaterThan(secondPrepare.start);
    await expect(
      fs.stat(
        path.join(
          pack.flowStepDir('two-page', 'step-03-click-fixture-co'),
          'desktop',
          UNIT_FILES.video,
        ),
      ),
    ).resolves.toBeTruthy();
  }, 300_000);

  it('blocks the step that failed and the ones that depend on it, keeping the trail', async () => {
    const r = await replayFlow({ root, flow: 'broken', session });
    const first = 'flow:broken/step-01-click-talk-to-us';
    const second = 'flow:broken/step-02-click-does-not-exist';
    const third = 'flow:broken/step-03-click-close';
    expect(r.captured).toEqual([first]);
    expect(r.blocked).toEqual([second, third]);
    const m = await loadManifest(root);
    expect(m.units[first]!.status).toBe('captured');
    expect(m.units[second]).toMatchObject({
      status: 'blocked',
      blockedReason: ERROR_CODES.unreachable,
      dependsOn: [first],
    });
    expect(m.units[second]!.question).toContain('Does Not Exist');
    expect(m.units[third]).toMatchObject({
      status: 'blocked',
      blockedReason: 'dependency',
      dependsOn: [second],
    });
    expect(m.units[third]!.question).toContain(second);
    // the steps that did run are recorded, so a rerun knows where the flow got to
    expect(m.flows['broken']!.steps).toEqual([first]);
    const pack = new PackPaths(root);
    await expect(
      fs.stat(pack.flowStepDir('broken', 'step-01-click-talk-to-us')),
    ).resolves.toBeTruthy();
    await expect(fs.stat(pack.flowStepDir('broken', 'step-03-click-close'))).rejects.toThrow();
  }, 300_000);

  it('stops before capturing anything when an input has no value', async () => {
    await expect(replayFlow({ root, flow: 'gated', session })).rejects.toMatchObject({
      code: ERROR_CODES.needsInput,
      message: expect.stringContaining('email'),
    });
    const pack = new PackPaths(root);
    await expect(fs.stat(pack.flowStepDir('gated', 'step-01-click-talk-to-us'))).rejects.toThrow();
    expect((await loadManifest(root)).flows['gated']!.steps).toEqual([]);
  });

  it('folds a scroll-only step into the next step and drops a trailing one', async () => {
    const r = await replayFlow({ root, flow: 'scrolled', session });
    expect(r.captured).toEqual([
      'flow:scrolled/step-01-click-talk-to-us',
      'flow:scrolled/step-03-input-email',
    ]);
    expect(r.blocked).toEqual([]);
    const m = await loadManifest(root);
    expect(m.flows['scrolled']!.steps).toEqual(r.captured);
    expect(Object.keys(m.units).filter((id) => id.startsWith('flow:scrolled/'))).toHaveLength(2);
    expect(m.units['flow:scrolled/step-03-input-email']!.dependsOn).toEqual([
      'flow:scrolled/step-01-click-talk-to-us',
    ]);
    // ours walks the same steps, the scroll included, from the step's own position
    const v = await verifyUnit({
      root,
      unitId: 'flow:scrolled/step-03-input-email',
      target: server.url,
      session,
    });
    expect(v.verdict).toBe('pass');
    expect(v.pixel.desktop!.score).toBe(0);
  }, 300_000);

  it('refuses to walk a flow step whose slug names another kind than the steps file', async () => {
    // a unit id says `step-02-click-...` where the recording has an input at step 2: the walk
    // would replay the wrong action and verify the wrong thing, so it stops with the mismatch
    const m = await loadManifest(root);
    m.flows['contact']!.steps.push('flow:contact/step-02-click-email');
    m.units['flow:contact/step-02-click-email'] = {
      ...m.units['flow:contact/step-02-input-email']!,
    };
    await saveManifest(root, m);
    const pack = new PackPaths(root);
    try {
      // verifyUnit reads the source before it ever reaches the mismatch check; the clone above
      // gives the fake unit a manifest record, and this the captured dir that record implies.
      // inside the try that owns the cleanup: a copy that fails halfway leaves a dir behind,
      // and every test after this one reads this pack
      await fs.cp(
        pack.flowStepDir('contact', 'step-02-input-email'),
        pack.flowStepDir('contact', 'step-02-click-email'),
        { recursive: true },
      );
      await expect(
        verifyUnit({
          root,
          unitId: 'flow:contact/step-02-click-email',
          target: server.url,
          session,
        }),
      ).rejects.toThrow(/names step 2 as a click, but step 2 in the steps file is an? input/);
    } finally {
      await fs.rm(pack.flowStepDir('contact', 'step-02-click-email'), {
        recursive: true,
        force: true,
      });
      const back = await loadManifest(root);
      back.flows['contact']!.steps = back.flows['contact']!.steps.filter(
        (s) => !s.endsWith('click-email'),
      );
      delete back.units['flow:contact/step-02-click-email'];
      await saveManifest(root, back);
    }
  });
});
