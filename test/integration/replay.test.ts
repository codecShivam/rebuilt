import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { serveStatic } from '../helpers/serve';
import { openPage, openSession, type OpenedPage, type Session } from '../../src/capture/session';
import { inPage } from '../../src/capture/browser/in-page';
import {
  describeTarget as describeTargetHelper,
  interactiveAncestor as interactiveAncestorHelper,
} from '../../src/capture/browser/targets';
import { performAction, replayActions, resolveTarget } from '../../src/capture/replay';
import { DEFAULT_VIEWPORTS, ERROR_CODES } from '../../src/pack/defaults';
import type { Action, Target } from '../../src/pack/schemas';

// the helpers are declared in the page by inPage(fn, [helper]); these ambient declarations
// let the wrappers below reference them by name (see src/capture/browser/in-page.ts)
declare function describeTarget(el: Element): Target;
declare function interactiveAncestor(el: Element): Element;

function describeSelector(css: string): Target {
  return describeTarget(document.querySelector(css)!);
}
function ancestorTagOf(css: string): string {
  return interactiveAncestor(document.querySelector(css)!).tagName;
}

let server: Awaited<ReturnType<typeof serveStatic>>;
let session: Session;
let opened: OpenedPage;
let page: Page;
const adHoc: { dir: string; server: Awaited<ReturnType<typeof serveStatic>> }[] = [];

// claude: second copy of this helper (test/integration/record.test.ts has one); a third gets
// it moved into test/helpers/serve.ts
/** an ad hoc site, served from its own temp dir; the fixtures stay untouched. */
async function serveFiles(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'site-replay-page-'));
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body);
  }
  const srv = await serveStatic(dir);
  adHoc.push({ dir, server: srv });
  return `${srv.url}/`;
}

async function servePage(html: string): Promise<string> {
  return serveFiles({ 'index.html': html });
}

const click = (target: Target): Action => ({
  kind: 'click',
  target,
  value: null,
  input: null,
  scroll: null,
});
const TALK: Target = {
  role: { role: 'button', name: 'Talk to us' },
  text: 'Talk to us',
  css: '#open-modal',
};
const EMAIL: Target = { role: { role: 'textbox', name: 'Email' }, text: null, css: '#modal input' };

beforeAll(async () => {
  server = await serveStatic(path.resolve('test/fixtures/site'));
  session = await openSession({});
  opened = await openPage(session, DEFAULT_VIEWPORTS.desktop);
  page = opened.page;
});
afterAll(async () => {
  await opened.release();
  await session.close();
  await server.close();
  await Promise.all(adHoc.map((a) => a.server.close()));
  await Promise.all(adHoc.map((a) => fs.rm(a.dir, { recursive: true, force: true })));
});

describe('describeTarget', () => {
  it('names an element by role and accessible name, visible text and a css path', async () => {
    await page.goto(`${server.url}/`, { waitUntil: 'load' });
    const describe = inPage(describeSelector, [describeTargetHelper]);
    expect(await page.evaluate(describe, '#open-modal')).toEqual({
      role: { role: 'button', name: 'Talk to us' },
      text: 'Talk to us',
      css: '#open-modal',
    });
    expect(await page.evaluate(describe, '.has-menu > .nav-link')).toEqual({
      role: { role: 'button', name: 'Products' },
      text: 'Products',
      css: 'body>header:nth-of-type(1)>nav:nth-of-type(1)>ul:nth-of-type(1)>li:nth-of-type(1)>button:nth-of-type(1)',
    });
    // a hidden input has no visible text; its wrapping label is its name
    expect(await page.evaluate(describe, '#modal input')).toEqual({
      role: { role: 'textbox', name: 'Email' },
      text: null,
      css: 'body>div:nth-of-type(1)>div:nth-of-type(1)>form:nth-of-type(1)>label:nth-of-type(1)>input:nth-of-type(1)',
    });
    // a summary has no role playwright knows; text and css carry it
    expect(await page.evaluate(describe, '.faq details:nth-of-type(1) summary')).toEqual({
      role: null,
      text: 'Is it accurate?',
      css: 'body>main:nth-of-type(1)>section:nth-of-type(3)>details:nth-of-type(1)>summary:nth-of-type(1)',
    });
  });

  it('walks up from a label to its control and from inline content to its button', async () => {
    const ancestor = inPage(ancestorTagOf, [interactiveAncestorHelper]);
    expect(await page.evaluate(ancestor, '#modal label')).toBe('INPUT');
    expect(await page.evaluate(ancestor, '#modal-title')).toBe('H2');
  });
});

describe('resolveTarget', () => {
  it('prefers the role, falls back to text, then to the css path', async () => {
    await page.goto(`${server.url}/`, { waitUntil: 'load' });
    // 'About' is a link twice (nav and footer) and text twice: only the css path is unique
    const about = await resolveTarget(page, {
      role: { role: 'link', name: 'About' },
      text: 'About',
      css: 'body>header:nth-of-type(1)>nav:nth-of-type(1)>ul:nth-of-type(1)>li:nth-of-type(2)>a:nth-of-type(1)',
    });
    expect(await about!.getAttribute('class')).toBe('nav-link');
    // 'Talk to us' is a heading as well as a button: the role disambiguates
    const talk = await resolveTarget(page, { ...TALK, css: 'nope' });
    expect(await talk!.getAttribute('id')).toBe('open-modal');
    const faq = await resolveTarget(page, { role: null, text: 'Is it accurate?', css: 'nope' });
    expect(await faq!.evaluate((el) => el.tagName)).toBe('SUMMARY');
    // the email field is inside the hidden modal: role and text see nothing, css sees it hidden
    expect(await resolveTarget(page, EMAIL)).toBeNull();
    expect(
      await resolveTarget(page, { role: null, text: null, css: '#does-not-exist' }),
    ).toBeNull();
  });
});

describe('a role attribute playwright cannot query', () => {
  it('names the element by the first role token and still resolves through css', async () => {
    const url = await servePage(
      '<div id="multi" role="button link" aria-expanded="false">Multi</div>',
    );
    await page.goto(url, { waitUntil: 'load' });
    const describeIt = inPage(describeSelector, [describeTargetHelper]);
    expect(await page.evaluate(describeIt, '#multi')).toEqual({
      role: { role: 'button', name: 'Multi' },
      text: 'Multi',
      css: '#multi',
    });
    // a pack captured before the role was trimmed still has to resolve: the role lookup is
    // not a selector playwright can run, and the walk falls through to the css path
    const found = await resolveTarget(page, {
      role: { role: 'button link', name: 'Multi' },
      text: null,
      css: '#multi',
    });
    expect(await found!.getAttribute('id')).toBe('multi');
  });
});

describe('replayActions', () => {
  it('clicks, fills from a flow input, changes a checkbox and presses enter', async () => {
    await page.goto(`${server.url}/`, { waitUntil: 'load' });
    await replayActions(
      page,
      [click(TALK), { kind: 'input', target: EMAIL, value: null, input: 'email', scroll: null }],
      { email: 'ada@example.com' },
    );
    expect(await page.getByRole('dialog').isVisible()).toBe(true);
    expect(await page.locator('#modal input').inputValue()).toBe('ada@example.com');

    await page.goto(`${server.url}/app.html`, { waitUntil: 'load' });
    const NAME: Target = {
      role: { role: 'textbox', name: 'Name' },
      text: null,
      css: '.contact input',
    };
    await replayActions(page, [
      { kind: 'input', target: NAME, value: 'Ada', input: null, scroll: null },
      { kind: 'scroll', target: null, value: null, input: null, scroll: { x: 0, y: 200 } },
      { kind: 'keydown', target: NAME, value: 'Enter', input: null, scroll: null },
    ]);
    await page.waitForURL(/name=Ada/);
  });

  it('waits for a navigation the step recorded before returning', async () => {
    const NAME: Target = {
      role: { role: 'textbox', name: 'Name' },
      text: null,
      css: '.contact input',
    };
    await page.goto(`${server.url}/app.html`, { waitUntil: 'load' });
    // the fixture server answers instantly, which hides the race: holding the landing page
    // back catches a replay that walks on with the old document still loaded
    const slow = (url: URL) => url.pathname === '/app.html' && url.search !== '';
    await page.route(slow, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });
    try {
      await replayActions(page, [
        {
          kind: 'input',
          target: NAME,
          value: 'Ada',
          input: null,
          scroll: null,
          url: `${server.url}/app.html`,
        },
        {
          kind: 'keydown',
          target: NAME,
          value: 'Enter',
          input: null,
          scroll: null,
          url: `${server.url}/app.html?name=Ada`,
        },
      ]);
      expect(page.url()).toContain('name=Ada');
    } finally {
      await page.unroute(slow);
    }
  });

  it('waits for a navigation that lands on a fragment', async () => {
    // the recorded url carries the fragment; the wait is about the document, so it must not
    // hold out for a url string the page will never report
    const base = await serveFiles({
      'index.html': '<a id="go" href="/b.html#sec">Go</a>',
      'b.html': '<h1 id="sec">Section</h1>',
    });
    const landed = new URL('/b.html#sec', base).toString();
    await page.goto(base, { waitUntil: 'load' });
    const started = Date.now();
    await replayActions(page, [
      {
        kind: 'click',
        target: { role: null, text: 'Go', css: '#go' },
        value: null,
        input: null,
        scroll: null,
        url: landed,
      },
    ]);
    expect(page.url()).toBe(landed);
    // a wait that never matches would sit out RECORD.navigationTimeout and then block the unit
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('changes a checkbox and a select to the recorded values', async () => {
    const url = await servePage(`
      <label for="agree">Agree</label>
      <input type="checkbox" id="agree" name="agree" />
      <label for="plan">Plan</label>
      <select id="plan" name="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
    `);
    await page.goto(url, { waitUntil: 'load' });
    const check: Target = { role: { role: 'checkbox', name: 'Agree' }, text: null, css: '#agree' };
    const select: Target = { role: { role: 'combobox', name: 'Plan' }, text: null, css: '#plan' };
    await replayActions(page, [
      { kind: 'change', target: check, value: 'true', input: null, scroll: null },
      { kind: 'change', target: select, value: 'pro', input: null, scroll: null },
    ]);
    expect(await page.locator('#agree').isChecked()).toBe(true);
    expect(await page.locator('#plan').inputValue()).toBe('pro');
    await performAction(
      page,
      { kind: 'change', target: check, value: 'false', input: null, scroll: null },
      {},
    );
    expect(await page.locator('#agree').isChecked()).toBe(false);
  });

  it('throws unreachable for a hidden target and needs_input for a missing input', async () => {
    await page.goto(`${server.url}/`, { waitUntil: 'load' });
    await expect(
      performAction(page, click({ role: null, text: null, css: '#close-modal' }), {}),
    ).rejects.toMatchObject({
      code: ERROR_CODES.unreachable,
    });
    await performAction(page, click(TALK), {});
    await expect(
      performAction(
        page,
        { kind: 'input', target: EMAIL, value: null, input: 'email', scroll: null },
        {},
      ),
    ).rejects.toMatchObject({
      code: ERROR_CODES.needsInput,
      message: expect.stringContaining('email'),
    });
  });
});

describe('describeTarget names and limits', () => {
  it('names by aria-label and by label[for], keeps the implicit role behind role="", and drops a name past NAME_MAX', async () => {
    const long = 'x'.repeat(81);
    const url = await servePage(
      '<button aria-label="Close dialog">x</button>' +
        '<label for="e">Email address</label><input id="e" type="text">' +
        '<button role="">Go</button>' +
        `<button id="long">${long}</button>`,
    );
    await page.goto(url, { waitUntil: 'load' });
    const describeIt = inPage(describeSelector, [describeTargetHelper]);
    expect(await page.evaluate(describeIt, '[aria-label]')).toEqual({
      role: { role: 'button', name: 'Close dialog' },
      text: 'x',
      css: 'body>button:nth-of-type(1)',
    });
    expect(await page.evaluate(describeIt, '#e')).toEqual({
      role: { role: 'textbox', name: 'Email address' },
      text: null,
      css: '#e',
    });
    // playwright's role engine falls back to the implicit role for an empty attribute
    expect(await page.evaluate(describeIt, 'button[role]')).toEqual({
      role: { role: 'button', name: 'Go' },
      text: 'Go',
      css: 'body>button:nth-of-type(2)',
    });
    const tooLong = await page.evaluate(describeIt, '#long');
    expect(tooLong.role).toBeNull();
    expect(tooLong.text).toBeNull();
    expect(tooLong.css).toBe('#long');
  });
});

describe('performAction hover', () => {
  it('hovers a target and the page reacts to the pointer until it leaves', async () => {
    await page.goto(`${server.url}/`, { waitUntil: 'load' });
    const menu = page.locator('.has-menu .menu');
    expect(await menu.isVisible()).toBe(false);
    await performAction(
      page,
      {
        kind: 'hover',
        target: {
          role: { role: 'button', name: 'Products' },
          text: 'Products',
          css: '.has-menu .nav-link',
        },
        value: null,
        input: null,
        scroll: null,
      },
      {},
    );
    expect(await menu.isVisible()).toBe(true);
    await page.mouse.move(0, 0);
    expect(await menu.isVisible()).toBe(false);
  });
});
