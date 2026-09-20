import type { Page } from 'playwright';
import { inPage } from './browser/in-page';

/**
 * in-page half, self-contained: passed to page.evaluate through inPage. a finite animation
 * is run to its end (a fade-in rewound to zero would capture the hero invisible); an endless
 * one is parked at time zero so two shots agree on its phase. returns how many were handled.
 */
export function freezeAnimationsInPage(): number {
  let frozen = 0;
  document.getAnimations().forEach((a) => {
    const t = a.effect?.getComputedTiming();
    try {
      if (t && Number.isFinite(t.endTime)) a.finish();
      else {
        a.pause();
        a.currentTime = 0;
      }
      frozen++;
    } catch {
      // finish() throws InvalidStateError on a finite animation whose playbackRate is 0;
      // such an animation is not moving, which is all the shots need
    }
  });
  return frozen;
}

// claude: milestone 3 records video and cdp animation events before this runs; keep the
// freeze as the last thing before extraction so the recording sees the motion.
export async function freezeAnimations(page: Page): Promise<number> {
  return page.evaluate(inPage(freezeAnimationsInPage), undefined);
}
