import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright';
import type { Viewport } from '../pack/defaults';

export interface Session {
  browser: Browser | null;
  /** set when connected over cdp: nothing is emulated, pages are resized to the viewport instead. */
  attached: { endpoint: string; scale: number } | null;
  newContext(viewport: Viewport, extra?: BrowserContextOptions): Promise<BrowserContext>;
  close(): Promise<void>;
}

export interface OpenedPage {
  page: Page;
  context: BrowserContext;
  /** gives back what openPage took: the context in a launched browser, only the page when attached. */
  release(): Promise<void>;
}

export function contextOptionsFor(viewport: Viewport): BrowserContextOptions {
  return {
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.scale,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    locale: 'en-US',
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  };
}

/** a window-sized context (`viewport: null`, the recorder) cannot carry emulation flags. */
function mergeOptions(viewport: Viewport, extra?: BrowserContextOptions): BrowserContextOptions {
  const base = contextOptionsFor(viewport);
  if (extra && 'viewport' in extra && extra.viewport === null) {
    delete base.deviceScaleFactor;
    delete base.isMobile;
    delete base.hasTouch;
  }
  return { ...base, ...extra };
}

/**
 * one browser per session.
 * - default: a launched chromium; every context is fresh.
 * - profileDir: every context is a persistent context on that profile, which is how logins
 *   and consent survive between runs.
 * - attach: chromium.connectOverCDP to a chrome the user started with
 *   --remote-debugging-port. its default context is the user's real profile and the only
 *   context used; a new context there would be a clean profile, which defeats the point.
 */
export async function openSession(opts: {
  profileDir?: string;
  headless?: boolean;
  attach?: string;
}): Promise<Session> {
  const headless = opts.headless ?? true;
  if (opts.attach) {
    const endpoint = opts.attach;
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const context = browser.contexts()[0] ?? (await browser.newContext());
    // no emulation over cdp: the pack records the attached chrome's own pixel ratio, read
    // after a resize because that is how every attached page is opened (openPage) and
    // playwright's setViewportSize emulates at a ratio of 1 whatever the window's display is:
    // probed before the resize, a retina window reported 2 while every shot came out at 1x
    // claude: found on the first real attach capture (testlibrary.com); the m3 attach test never checked the ratio against a shot
    const probe = await context.newPage();
    await probe.setViewportSize({ width: 1024, height: 768 });
    const scale = await probe.evaluate(() => window.devicePixelRatio);
    await probe.close();
    return {
      browser,
      attached: { endpoint, scale },
      // `extra` is a no-op here: this context is the user's own, already open, and playwright
      // cannot re-create it with other options (the recorder's `viewport: null` included), so
      // an attached page is sized by openPage instead
      newContext: async () => context,
      // close() on a connected browser disconnects; the user's chrome keeps running
      close: () => browser.close(),
    };
  }
  if (opts.profileDir) {
    const profileDir = opts.profileDir;
    return {
      browser: null,
      attached: null,
      newContext: (viewport, extra) =>
        chromium.launchPersistentContext(profileDir, {
          headless,
          ...mergeOptions(viewport, extra),
        }),
      close: async () => {},
    };
  }
  const browser = await chromium.launch({ headless });
  return {
    browser,
    attached: null,
    newContext: (viewport, extra) => browser.newContext(mergeOptions(viewport, extra)),
    close: () => browser.close(),
  };
}

/**
 * a page at the viewport size and the way to give it back. every consumer of a page goes
 * through here, so the attached case (one shared context, resize the page) and the launched
 * case (a context per viewport) look the same to the pipeline, explore and the recorder.
 */
export async function openPage(
  session: Session,
  viewport: Viewport,
  extra?: BrowserContextOptions,
): Promise<OpenedPage> {
  const context = await session.newContext(viewport, extra);
  if (session.attached) {
    // never reuse a page here: the default context holds the user's own tabs
    const page = await context.newPage();
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    return { page, context, release: () => page.close() };
  }
  // a persistent context opens with a blank page; use it rather than leaving a stray tab
  const page = context.pages()[0] ?? (await context.newPage());
  return { page, context, release: () => context.close() };
}

/**
 * the viewport as this session can realise it: an attached chrome emulates nothing, so it
 * keeps its own pixel ratio and no mobile flags, and masks and crops are cut at that scale.
 */
export function viewportFor(session: Session, viewport: Viewport): Viewport {
  return session.attached
    ? { ...viewport, scale: session.attached.scale, mobile: false }
    : viewport;
}
