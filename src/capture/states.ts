import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import type { Viewport } from '../pack/defaults';
import { ERROR_CODES, REPLAY, STATE } from '../pack/defaults';
import { slugify } from '../pack/ids';
import { diffPngs } from '../pack/image';
import type { Action, Rect, Target } from '../pack/schemas';
import { inPage } from './browser/in-page';
import { describeTarget as describeTargetHelper } from './browser/targets';
import { freezeAnimations } from './freeze';
import { dynamicMasks } from './masks';
import { performAction, resolveTarget } from './replay';
import { settle } from './settle';

// declared in the page by inPage(findTriggersInPage, [describeTargetHelper]); see in-page.ts
declare function describeTarget(el: Element): Target;

export type TriggerKind = 'hover' | 'menu' | 'accordion' | 'tab' | 'button';

export interface Trigger {
  kind: TriggerKind;
  name: string;
  target: Target;
}

export interface DiscoveredState {
  name: string;
  actions: Action[];
}

/**
 * in-page: every visible trigger worth a try, in dom order. self-contained apart from the
 * ambient describeTarget. an element can be both a hover trigger (it sits in a nav) and a
 * click trigger (it has aria-expanded), so the two kinds are deduplicated separately.
 */
export function findTriggersInPage(opts: { max: number }): Trigger[] {
  function visible(el: Element): boolean {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function clean(s: string | null | undefined): string {
    return (s ?? '').replace(/\s+/g, ' ').trim();
  }
  const out: Trigger[] = [];
  const hovered = new Set<Element>();
  const clicked = new Set<Element>();
  function add(el: Element, kind: TriggerKind): void {
    const bucket = kind === 'hover' ? hovered : clicked;
    if (bucket.has(el) || !visible(el)) return;
    bucket.add(el);
    const target = describeTarget(el);
    const name = target.role?.name || target.text || clean(el.getAttribute('aria-label')) || '';
    out.push({ kind, name, target });
  }
  document
    .querySelectorAll(
      'nav a, nav button, [role="navigation"] a, [role="navigation"] button, [role="menubar"] [role="menuitem"]',
    )
    .forEach((el) => add(el, 'hover'));
  document.querySelectorAll('[aria-haspopup], [aria-expanded]').forEach((el) => add(el, 'menu'));
  document.querySelectorAll('details > summary').forEach((el) => add(el, 'accordion'));
  document.querySelectorAll('[role="tab"]').forEach((el) => add(el, 'tab'));
  document.querySelectorAll('button, [role="button"]').forEach((el) => {
    // a form's buttons submit and a nav's are menus (listed above); the rest may open a dialog
    if (el.closest('form') || el.closest('nav')) return;
    if ((el.getAttribute('type') || '').toLowerCase() === 'submit') return;
    add(el, 'button');
  });
  return out.slice(0, opts.max);
}

function stateName(trigger: Trigger, taken: Set<string>): string {
  const slug = slugify(trigger.name).split('-').filter(Boolean).slice(0, 5).join('-') || 'unnamed';
  const base = {
    hover: `hover-nav-${slug}`,
    menu: `menu-${slug}-open`,
    accordion: `accordion-${slug}-open`,
    tab: `tab-${slug}`,
    button: `modal-${slug}`,
  }[trigger.kind];
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  taken.add(name);
  return name;
}

/** the window's scroll offset in css px: what a viewport shot starts at. */
interface Offset {
  x: number;
  y: number;
}

async function shoot(page: Page, opts: { fullPage?: boolean } = {}): Promise<PNG> {
  return PNG.sync.read(await page.screenshot({ type: 'png', fullPage: opts.fullPage ?? false }));
}

async function scrollOffset(page: Page): Promise<Offset> {
  return page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
}

/**
 * a trigger that navigated late, or closed the page, tears the execution context down under
 * whatever evaluate or screenshot is in flight. that is not a state, it is a page that left.
 */
function navigatedAway(err: unknown, page: Page): boolean {
  if (page.isClosed()) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /execution context was destroyed|target closed|target page, context or browser has been closed|page, context or browser has been closed|frame was detached|navigating and changing the content/i.test(
    message,
  );
}

async function dialogOpen(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"]')).some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
    }),
  );
}

/** the same document, ignoring the fragment: a tab link that sets `#panel` did not navigate. */
function sameDocument(a: string, b: string): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  ua.hash = '';
  ub.hash = '';
  return ua.toString() === ub.toString();
}

/**
 * try every trigger on a page that is loaded and settled at the top, and keep the ones
 * that change what the viewport shows. a hover ends when the pointer leaves; anything
 * clicked is undone by a reload, so every trigger starts from the same resting page.
 *
 * each trigger is judged against its own baseline, taken at the scroll offset the trigger is
 * reached at: playwright scrolls a target into view before acting, so a shot compared against
 * a top-of-page baseline would differ by that scroll alone and every link below the fold
 * would read as a state.
 */
export async function discoverStates(
  page: Page,
  url: string,
  viewport: Viewport,
  /** the pack's rest-shot span; SETTLE's when the caller has no manifest */
  dynamic: { shots?: number; gap?: number } = {},
): Promise<DiscoveredState[]> {
  const resting = page.url();
  // regions that move on their own (a live counter) are masked out of every comparison, in
  // page coordinates so they can be shifted into whatever viewport frame a trigger is judged
  // in. each mask is the live element's own box (masks.ts), so a state change next to a live
  // region is still seen
  let masks: Rect[] = [];
  let maskedUrl = '';
  const takeMasks = async () => {
    await page.mouse.move(0, 0);
    await freezeAnimations(page);
    masks = (await dynamicMasks(page, viewport, dynamic)).masks;
    maskedUrl = page.url();
  };
  const reset = async () => {
    // the pointer leaves first: after a reload it would still hover whatever sits under it
    await page.mouse.move(0, 0);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('load', { timeout: 60_000 }).catch(() => {});
    // with the scroll sweep: this page holds no interactive state for the sweep to disturb,
    // and the next trigger's baseline is shot wherever that trigger sits, which lazy content
    // would otherwise still be loading into between the before and after shots
    await settle(page);
    await freezeAnimations(page);
    // nothing from the load before this one is reused: only the masks survive, and only
    // while the page is still the one they were measured on
    if (page.url() !== maskedUrl) await takeMasks();
  };
  // claude: masks stay in page coordinates, so a sticky or fixed dynamic element (a cookie
  // bar with a countdown) is masked where it sat at the top of the page and unmasked wherever
  // it renders at a scrolled offset; the fix is a mask flagged `fixed` that verify applies in
  // viewport space, once a real site needs it.
  const changed = (before: PNG, after: PNG, at: Offset): boolean => {
    const shifted = masks.map((m) => ({ ...m, x: m.x - at.x, y: m.y - at.y }));
    return diffPngs(before, after, { masks: shifted, scale: viewport.scale }).mismatched > 0;
  };
  await takeMasks();

  const triggers = await page.evaluate(inPage(findTriggersInPage, [describeTargetHelper]), {
    max: STATE.maxTriggers,
  });
  // a trigger that opens a tab is not a state, and the tab must not outlive the trigger. the
  // popup event fires only for pages this page opened, so an attached session's own context
  // (the user's chrome, with the user's own tabs in it) is left alone.
  let popped = false;
  const onPopup = (popup: Page) => {
    popped = true;
    void popup.close().catch(() => {});
  };
  page.on('popup', onPopup);
  const found: DiscoveredState[] = [];
  const taken = new Set<string>();
  try {
    for (const trigger of triggers) {
      if (page.isClosed()) break;
      const action: Action = {
        kind: trigger.kind === 'hover' ? 'hover' : 'click',
        target: trigger.target,
        value: null,
        input: null,
        scroll: null,
      };
      // the target is brought into view first, and the baseline is taken there: the scroll
      // playwright would do inside the action must not land in the comparison
      const locator = await resolveTarget(page, trigger.target);
      if (!locator) continue;
      try {
        await locator.scrollIntoViewIfNeeded({ timeout: REPLAY.actionTimeout });
      } catch {
        // a trigger that cannot be scrolled to is gone or hidden since the scan: not a state
        continue;
      }
      await page.waitForTimeout(STATE.settleAfterScroll);
      const at = await scrollOffset(page);
      const before = await shoot(page);
      popped = false;
      try {
        await performAction(page, action, {});
      } catch (err) {
        if ((err as { code?: string }).code !== ERROR_CODES.unreachable) throw err;
        continue;
      }
      await page.waitForTimeout(STATE.afterAction);
      let keep = false;
      let reverted = false;
      if (sameDocument(page.url(), resting)) {
        try {
          await freezeAnimations(page);
          let after = await shoot(page);
          const now = await scrollOffset(page);
          if (now.x !== at.x || now.y !== at.y) {
            // a hover must not move the page, and a click that scrolled is judged where it
            // started: the scroll on its own is not a state
            await page.evaluate((o) => window.scrollTo(o.x, o.y), at);
            await page.waitForTimeout(STATE.settleAfterScroll);
            after = await shoot(page);
          }
          // a plain button counts only when a dialog appeared; attribute triggers count on
          // any change, and a trigger that opened a tab changed nothing on this page
          keep = popped
            ? false
            : trigger.kind === 'button'
              ? await dialogOpen(page)
              : changed(before, after, at);
          if (trigger.kind === 'hover') {
            await page.mouse.move(0, 0);
            await page.waitForTimeout(STATE.afterReset);
            reverted = !changed(before, await shoot(page), at);
          }
        } catch (err) {
          if (!navigatedAway(err, page)) throw err;
          keep = false;
          reverted = false;
        }
      }
      if (keep) found.push({ name: stateName(trigger, taken), actions: [action] });
      // a hover the pointer already undid leaves the page as it was: no reload needed
      if (reverted) continue;
      if (page.isClosed()) break;
      await reset();
    }
  } finally {
    // the crawl reuses this page for the next url: one listener per page discovered would pile up
    page.off('popup', onPopup);
  }
  return found;
}
