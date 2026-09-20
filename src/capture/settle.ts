import type { Page } from 'playwright';
import { SETTLE } from '../pack/defaults';

/**
 * wait for the page to be still. with `scroll` (the default) the page is swept top to
 * bottom first so lazy content loads. `scroll: false` skips the sweep for a page that
 * already had one and now holds an interactive state: the sweep would move the pointer
 * off a hovered menu, and a modal with `overflow: hidden` on body defeats it anyway. both
 * variants end at the top, so element rects and the full-page shot agree on positions.
 */
export async function settle(page: Page, opts: { scroll?: boolean } = {}): Promise<void> {
  if (opts.scroll ?? true) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height + SETTLE.scrollStep; y += SETTLE.scrollStep) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(SETTLE.scrollPause);
    }
  }
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(SETTLE.afterScroll);
}
