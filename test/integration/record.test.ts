import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execa } from 'execa';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { serveStatic } from '../helpers/serve';
import { openSession, type Session } from '../../src/capture/session';
import { startRecording } from '../../src/capture/record';
import { loadManifest, readJson } from '../../src/pack/io';
import { PackPaths } from '../../src/pack/paths';
import { StepsFileSchema } from '../../src/pack/schemas';
import { RECORD } from '../../src/pack/defaults';

let server: Awaited<ReturnType<typeof serveStatic>>;
let session: Session;
const tmpDirs: string[] = [];
const adHocServers: Awaited<ReturnType<typeof serveStatic>>[] = [];

async function tmp(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** an ad hoc single-page site, served from its own temp dir; the real fixtures stay untouched. */
async function servePage(html: string): Promise<string> {
  const dir = await tmp('site-record-page-');
  await fs.writeFile(path.join(dir, 'index.html'), html);
  const srv = await serveStatic(dir);
  adHocServers.push(srv);
  return `${srv.url}/`;
}

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  session = await openSession({});
});
afterAll(async () => {
  await session.close();
  await server.close();
  await Promise.all(adHocServers.map((s) => s.close()));
  await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('startRecording', () => {
  it('records typing, enter, clicks and a masked email, then writes the steps file when the context closes', async () => {
    const root = await tmp('site-pack-record-');
    const rec = await startRecording({
      root,
      flow: 'signup',
      start: `${server.url}/app.html`,
      session,
    });
    const { page } = rec;
    const name = page.getByRole('textbox', { name: 'Name', exact: true });
    await name.fill('Ada');
    await name.press('Enter');
    await page.waitForURL(/name=Ada/);
    // a navigation inside the window after a step is taken as where that step led; wait it
    // out so the goto below is not read as the enter key's destination
    await page.waitForTimeout(RECORD.navigationWindow + 200);
    await page.goto(`${server.url}/`);
    await page.getByRole('button', { name: 'Talk to us' }).click();
    await page.getByRole('textbox', { name: 'Email', exact: true }).fill('ada@example.com');
    await page.getByRole('button', { name: 'Close' }).click();
    await page.waitForTimeout(500);
    await rec.context.close();
    const file = await rec.done;

    // playwright scrolls a target into view, and those scrolls are recorded like any other;
    // the assertions read the user's own actions
    const actions = file.steps.filter((s) => s.kind !== 'scroll');
    expect(actions.map((s) => s.kind)).toEqual(['input', 'keydown', 'click', 'input', 'click']);
    expect(actions[0]).toMatchObject({ value: 'Ada', input: null });
    expect(actions[0]!.target?.role).toEqual({ role: 'textbox', name: 'Name' });
    expect(actions[1]).toMatchObject({ kind: 'keydown', value: 'Enter' });
    expect(actions[1]!.url).toContain('name=Ada');
    expect(actions[2]!.target?.role).toEqual({ role: 'button', name: 'Talk to us' });
    expect(actions[3]).toMatchObject({ value: null, input: 'email' });
    expect(actions[4]!.target?.role).toEqual({ role: 'button', name: 'Close' });
    expect(JSON.stringify(file)).not.toContain('ada@example.com');
    expect(file.steps.map((s) => s.n)).toEqual(file.steps.map((_, i) => i + 1));
    for (const s of file.steps.filter((s) => s.kind === 'scroll')) {
      expect(s.scroll).toEqual({ x: expect.any(Number), y: expect.any(Number) });
    }

    const onDisk = await readJson(StepsFileSchema, new PackPaths(root).stepsFile('signup'));
    expect(onDisk).toEqual(file);
    const m = await loadManifest(root);
    expect(m.sourceUrl).toBe(`${server.url}/app.html`);
    expect(m.flows['signup']).toEqual({ steps: [], inputs: { email: null } });
    expect(
      m.questions.some((q) => q.id === 'flow:signup:input:email' && q.text.includes('email')),
    ).toBe(true);
  });

  it('refuses a flow name that is not a slug', async () => {
    await expect(
      startRecording({
        root: await tmp('site-pack-'),
        flow: 'Sign Up',
        start: `${server.url}/`,
        session,
      }),
    ).rejects.toThrow(/flow name/);
  });

  it('runs the injected recorder under tsx, the path bin/site takes', async () => {
    const root = await tmp('site-pack-driver-');
    const r = await execa(
      process.execPath,
      ['--import', 'tsx', path.resolve('test/helpers/record-driver.ts'), `${server.url}/`, root],
      { reject: false },
    );
    expect(r.exitCode, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as { kinds: string[] };
    expect(out.kinds.filter((k) => k !== 'scroll')).toEqual(['click']);
  });
});

describe('startRecording masking', () => {
  it('masks a type="password" field', async () => {
    const url = await servePage('<input type="password" name="pwd" />');
    const root = await tmp('site-pack-mask-pwd-');
    const rec = await startRecording({ root, flow: 'x', start: url, session });
    await rec.page.locator('input[name="pwd"]').fill('Secret123');
    await rec.page.waitForTimeout(100);
    await rec.context.close();
    const file = await rec.done;
    const inputs = file.steps.filter((s) => s.kind === 'input');
    expect(inputs.length).toBeGreaterThan(0);
    for (const s of inputs) expect(s).toMatchObject({ value: null, input: 'pwd' });
    expect(JSON.stringify(file)).not.toContain('Secret123');
  });

  it('masks a field flipped from password to text by a show-password toggle, via autocomplete', async () => {
    const url = await servePage(`
      <input type="password" id="pw2" autocomplete="current-password" />
      <button type="button" id="toggle">show</button>
      <script>
        document.getElementById('toggle').addEventListener('click', function () {
          document.getElementById('pw2').type = 'text';
        });
      </script>
    `);
    const root = await tmp('site-pack-mask-toggle-');
    const rec = await startRecording({ root, flow: 'x', start: url, session });
    const field = rec.page.locator('#pw2');
    await field.fill('hunter2');
    await rec.page.locator('#toggle').click();
    expect(await field.evaluate((el: HTMLInputElement) => el.type)).toBe('text');
    await field.fill('hunter2visible');
    await rec.page.waitForTimeout(100);
    await rec.context.close();
    const file = await rec.done;
    const inputs = file.steps.filter((s) => s.kind === 'input' && s.target?.css.includes('pw2'));
    expect(inputs.length).toBeGreaterThan(0);
    for (const s of inputs) expect(s).toMatchObject({ value: null, input: 'pw2' });
    expect(JSON.stringify(file)).not.toContain('hunter2');
  });

  it('masks a plain text field where the user types an email', async () => {
    const url = await servePage('<input type="text" name="note" />');
    const root = await tmp('site-pack-mask-text-email-');
    const rec = await startRecording({ root, flow: 'x', start: url, session });
    await rec.page.locator('input[name="note"]').fill('ada@example.com');
    await rec.page.waitForTimeout(100);
    await rec.context.close();
    const file = await rec.done;
    const inputs = file.steps.filter((s) => s.kind === 'input');
    expect(inputs.length).toBeGreaterThan(0);
    for (const s of inputs) expect(s).toMatchObject({ value: null, input: 'note' });
    expect(JSON.stringify(file)).not.toContain('ada@example.com');
  });

  it('masks a type="email" field left partially typed when the context closes', async () => {
    // the name says nothing about email, so only the type="email" branch can mask this one,
    // and the value stops before the '@' that would give it away
    const url = await servePage('<input type="email" name="contact_address" />');
    const root = await tmp('site-pack-mask-partial-email-');
    const rec = await startRecording({ root, flow: 'x', start: url, session });
    await rec.page.locator('input[name="contact_address"]').pressSequentially('ada.lovelace');
    await rec.page.waitForTimeout(100);
    await rec.context.close();
    const file = await rec.done;
    const inputs = file.steps.filter((s) => s.kind === 'input');
    expect(inputs.length).toBeGreaterThan(0);
    for (const s of inputs) expect(s).toMatchObject({ value: null, input: 'contact_address' });
    expect(JSON.stringify(file)).not.toContain('ada.lovelace');
  });

  it('keeps a checkbox value even when its name reads like a password field', async () => {
    const url = await servePage(
      '<label><input type="checkbox" name="remember_password" /> Remember</label>',
    );
    const root = await tmp('site-pack-checkbox-');
    const rec = await startRecording({ root, flow: 'x', start: url, session });
    await rec.page.locator('input[name="remember_password"]').check();
    await rec.page.waitForTimeout(100);
    await rec.context.close();
    const file = await rec.done;
    const changes = file.steps.filter((s) => s.kind === 'input' || s.kind === 'change');
    expect(changes.length).toBeGreaterThan(0);
    // a checkbox carries a boolean, never a secret: masking it would lose the step's meaning
    for (const s of changes) expect(s).toMatchObject({ value: 'true', input: null });
  });
});

describe('startRecording implicit-submit echo', () => {
  it('drops the echo inside the form but keeps a click outside it', async () => {
    const url = await servePage(`
      <form id="f1">
        <input type="text" name="solo" />
        <button type="submit">Send</button>
      </form>
      <button type="button" id="other">Other</button>
      <script>
        document.getElementById('f1').addEventListener('submit', function (e) {
          e.preventDefault();
        });
      </script>
    `);
    const root = await tmp('site-pack-form-scope-');
    const rec = await startRecording({ root, flow: 'x', start: url, session });
    const solo = rec.page.locator('input[name="solo"]');
    await solo.fill('hi');
    await solo.press('Enter');
    await rec.page.locator('#other').click();
    await rec.page.waitForTimeout(150);
    await rec.context.close();
    const file = await rec.done;
    const actions = file.steps.filter((s) => s.kind !== 'scroll');
    expect(actions.map((s) => s.kind)).toEqual(['input', 'keydown', 'click']);
    expect(actions[2]!.target?.role).toEqual({ role: 'button', name: 'Other' });
  });
});

describe('startRecording binding payload', () => {
  it('drops a malformed event and masks a forged email value, without losing the recording', async () => {
    const url = await servePage('<body></body>');
    const root = await tmp('site-pack-forged-');
    const rec = await startRecording({ root, flow: 'x', start: url, session });
    await rec.page.evaluate(async () => {
      const w = window as unknown as { __siteRecord: (e: unknown) => Promise<void> };
      // a page script can call the exposed binding directly with anything it likes: this is
      // the bounded risk documented next to maskEvent in record.ts, and both these calls
      // exercise it.
      await w.__siteRecord({ nonsense: true });
      await w.__siteRecord({
        kind: 'input',
        target: null,
        value: 'user@example.com',
        input: null,
        scroll: null,
        field: null,
        form: null,
      });
    });
    await rec.context.close();
    const file = await rec.done;
    const nonScroll = file.steps.filter((s) => s.kind !== 'scroll');
    expect(nonScroll).toHaveLength(1);
    expect(nonScroll[0]).toMatchObject({ kind: 'input', value: null });
    expect(nonScroll[0]!.input).toBeTruthy();
    expect(JSON.stringify(file)).not.toContain('user@example.com');
  });
});
