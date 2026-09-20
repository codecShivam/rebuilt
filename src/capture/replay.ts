import type { Locator, Page } from 'playwright';
import { ERROR_CODES, RECORD, REPLAY } from '../pack/defaults';
import type { Action, Target } from '../pack/schemas';

/** a recorded action: the url the recording ended that step on, when there is one. */
export type ReplayStep = Action & { url?: string };

/** a replay failure with a code the caller can branch on (ERROR_CODES.unreachable, ERROR_CODES.needsInput). */
export class ReplayError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ReplayError';
  }
}

type Role = Parameters<Page['getByRole']>[0];

/**
 * the first candidate that names exactly one visible element: role and accessible name,
 * then exact text, then the css path (first match). null when nothing visible matches.
 */
export async function resolveTarget(page: Page, target: Target): Promise<Locator | null> {
  // a pack can carry a role or a text the page's own markup made unusable as a selector (a
  // multi-token role attribute, say). each candidate that cannot be run falls through to the
  // next one rather than failing the whole lookup.
  if (target.role) {
    try {
      const byRole = page.getByRole(target.role.role as Role, {
        name: target.role.name,
        exact: true,
      });
      if ((await byRole.count()) === 1) return byRole;
    } catch {
      /* not a role playwright can query: try the text and the css path */
    }
  }
  if (target.text) {
    try {
      const byText = page.getByText(target.text, { exact: true });
      if ((await byText.count()) === 1 && (await byText.isVisible())) return byText;
    } catch {
      /* not a text selector playwright can query: try the css path */
    }
  }
  try {
    const byCss = page.locator(target.css);
    if ((await byCss.count()) >= 1 && (await byCss.first().isVisible())) return byCss.first();
  } catch {
    // an unusable css path leaves nothing else to try: the caller reads null as unreachable
    return null;
  }
  return null;
}

/**
 * the same path and query on the origin the page is on now: a rebuild lives somewhere else.
 * null when the page is on no origin at all (about:blank), where there is nothing to wait for.
 */
function rebasePath(recorded: string, current: string): string | null {
  try {
    const origin = new URL(current).origin;
    if (!/^https?:/.test(origin)) return null;
    const from = new URL(recorded);
    return new URL(from.pathname + from.search, origin).toString();
  } catch {
    return null;
  }
}

/** what identifies a document across origins and fragments: the path and the query. */
function pathAndQuery(url: string): string {
  const u = new URL(url);
  return u.pathname + u.search;
}

/** a step's recorded url is where that step left the page, so it navigated if that url moved. */
function navigates(step: ReplayStep, previousUrl: string): boolean {
  if (step.kind !== 'click' && step.kind !== 'keydown') return false;
  if (!step.url) return false;
  try {
    return pathAndQuery(step.url) !== pathAndQuery(previousUrl);
  } catch {
    return false;
  }
}

function describe(action: Action): string {
  const t = action.target;
  const name = t ? (t.role ? `${t.role.role} "${t.role.name}"` : (t.text ?? t.css)) : '';
  return name ? `${action.kind} ${name}` : action.kind;
}

function valueFor(action: Action, inputs: Record<string, string | null>): string {
  if (action.input) {
    const v = inputs[action.input];
    if (v === null || v === undefined) {
      throw new ReplayError(
        `input "${action.input}" has no value; set it under manifest.flows.<flow>.inputs.${action.input}`,
        ERROR_CODES.needsInput,
      );
    }
    return v;
  }
  return action.value ?? '';
}

/** perform one action. throws ReplayError(unreachable) when its target cannot be found or acted on. */
export async function performAction(
  page: Page,
  action: Action,
  inputs: Record<string, string | null>,
): Promise<void> {
  const timeout = REPLAY.actionTimeout;
  if (action.kind === 'scroll') {
    const to = action.scroll ?? { x: 0, y: 0 };
    await page.evaluate((s) => window.scrollTo(s.x, s.y), to);
    return;
  }
  if (!action.target) {
    throw new ReplayError(`${action.kind} has no target`, ERROR_CODES.unreachable);
  }
  try {
    // inside the try: a target resolved against a page that is navigating away throws from
    // the torn-down execution context, which is the same "not there" the null case reports
    const locator = await resolveTarget(page, action.target);
    if (!locator) {
      throw new ReplayError(`no visible element for ${describe(action)}`, ERROR_CODES.unreachable);
    }
    switch (action.kind) {
      case 'hover':
        await locator.hover({ timeout });
        break;
      case 'click':
        await locator.click({ timeout });
        break;
      case 'input':
        await locator.fill(valueFor(action, inputs), { timeout });
        break;
      case 'change': {
        const value = valueFor(action, inputs);
        const tag = await locator.evaluate((el) => el.tagName);
        const type = await locator.evaluate((el) => (el.getAttribute('type') ?? '').toLowerCase());
        if (tag === 'SELECT') await locator.selectOption(value, { timeout });
        else if (type === 'checkbox' || type === 'radio') {
          await locator.setChecked(value === 'true', { timeout });
        } else await locator.fill(value, { timeout });
        break;
      }
      case 'keydown':
        await locator.press(action.value ?? 'Enter', { timeout });
        break;
    }
  } catch (err) {
    if (err instanceof ReplayError) throw err;
    // a timeout or a detached element means the page did not offer the target as recorded
    throw new ReplayError(
      `${describe(action)}: ${err instanceof Error ? err.message : String(err)}`,
      ERROR_CODES.unreachable,
    );
  }
}

/**
 * replay actions in order with a short pause after each, so the page can react before the
 * next. a step whose recorded url differs from the one before it navigated: the walk waits
 * for that url on this origin before the next step, because a click on a page that is still
 * loading finds the old document or none at all.
 */
export async function replayActions(
  page: Page,
  actions: ReplayStep[],
  inputs: Record<string, string | null> = {},
): Promise<void> {
  // the first step is measured against where the walk starts, which is the start url
  let previousUrl = page.url();
  for (const action of actions) {
    const expected = navigates(action, previousUrl)
      ? rebasePath(action.url!, page.url())
      : undefined;
    await performAction(page, action, inputs);
    await page.waitForTimeout(REPLAY.afterAction);
    if (expected) {
      // the fragment is not part of what was waited for: a recorded step that landed on
      // `/b.html#sec` is the same document as `/b.html`, and the page never reports the url
      // the rebased path was built from
      const want = pathAndQuery(expected);
      try {
        await page.waitForURL((url) => url.pathname + url.search === want, {
          timeout: RECORD.navigationTimeout,
        });
        await page.waitForLoadState('load', { timeout: RECORD.navigationTimeout });
      } catch {
        // the step led somewhere else here: that is this unit's problem, not the run's
        throw new ReplayError(
          `${describe(action)} did not land on ${expected}; the page is at ${page.url()}`,
          ERROR_CODES.unreachable,
        );
      }
    }
    if (action.url) previousUrl = action.url;
  }
}
