import type { ViewportName } from '../pack/defaults';
import { DEFAULT_VIEWPORTS, ERROR_CODES, VIEWPORT_NAMES } from '../pack/defaults';
import { newManifest, saveManifest, loadManifest } from '../pack/io';
import { slugFromUrl, unitIdForPage, unitIdForState } from '../pack/ids';
import { blockUnit } from '../pack/units';
import type { Action, Manifest, UnitRecord } from '../pack/schemas';
import { openPage, viewportFor, type Session } from './session';
import { settle } from './settle';
import { discoverStates, type DiscoveredState } from './states';

const ASSET_EXTENSIONS = /\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|css|js)$/i;

function inScope(url: string, origin: string, scope: string[]): boolean {
  const u = new URL(url);
  if (u.origin !== origin) return false;
  if (!scope.length) return true;
  return scope.some((glob) => globToRegExp(glob).test(u.pathname));
}

/** turns a shell-style glob into a regexp: `**` crosses `/`, a lone `*` stays within one segment. */
export function globToRegExp(glob: string): RegExp {
  const re = glob
    .replace(/[.+^${}()|[\]\\?]/g, '\\$&')
    .replace(/\*+/g, (run) => (run.length > 1 ? '.*' : '[^/]*'));
  return new RegExp(`^${re}$`);
}

function normalise(url: string): string {
  const u = new URL(url);
  u.hash = '';
  u.search = '';
  return u.toString();
}

/** a state as the passes found it: the first pass's actions, every viewport that reached it, and each pass's own actions */
export interface FoundState {
  actions: Action[];
  reachable: ViewportName[];
  byViewport: Partial<Record<ViewportName, Action[]>>;
}

/** fold one pass's discovery of a state into what the passes found so far */
export function recordState(
  found: Map<string, FoundState>,
  viewport: ViewportName,
  state: DiscoveredState,
): void {
  const entry = found.get(state.name);
  if (entry) {
    if (!entry.reachable.includes(viewport)) entry.reachable.push(viewport);
    entry.byViewport[viewport] = state.actions;
  } else {
    found.set(state.name, {
      actions: state.actions,
      reachable: [viewport],
      byViewport: { [viewport]: state.actions },
    });
  }
}

/** the unit's action fields: one list when every pass used the same trigger, one per viewport otherwise */
export function unitActions(state: FoundState): {
  actions: Action[];
  actionsByViewport?: UnitRecord['actionsByViewport'];
} {
  const shared = JSON.stringify(state.actions);
  const differ = state.reachable.some((v) => JSON.stringify(state.byViewport[v]) !== shared);
  return differ
    ? { actions: state.actions, actionsByViewport: state.byViewport }
    : { actions: state.actions };
}

/**
 * crawl same-origin links to a depth, register every page as a planned unit, and discover
 * each page's interactive states at every viewport as planned state units that depend on
 * their page and say which viewports reach them.
 */
export async function explore(opts: {
  root: string;
  url: string;
  depth: number;
  scope: string[];
  session: Session;
  /** default true; false plans pages only. */
  states?: boolean;
}): Promise<Manifest> {
  const start = normalise(opts.url);
  const origin = new URL(start).origin;
  const withStates = opts.states ?? true;
  let manifest: Manifest;
  try {
    manifest = await loadManifest(opts.root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    manifest = newManifest({ host: new URL(start).host, sourceUrl: start });
  }
  manifest.capture.crawlDepth = opts.depth;
  manifest.capture.scope = opts.scope;
  const now = () => new Date().toISOString();

  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
  // a url the manifest already knows is not queued again; the start url always is
  const seen = new Set<string>([start]);
  for (const unit of Object.values(manifest.units)) {
    if (unit.kind === 'page' && unit.url) seen.add(unit.url);
  }
  // desktop first: the crawl reads links there. an attached chrome cannot emulate, so the
  // viewports carry its scale, which is what the discovery masks are cut at
  const passes = [
    viewportFor(opts.session, DEFAULT_VIEWPORTS.desktop),
    viewportFor(opts.session, DEFAULT_VIEWPORTS.mobile),
  ];
  while (queue.length) {
    const { url, depth } = queue.shift()!;
    const slug = slugFromUrl(url);
    const id = unitIdForPage(slug);
    const found = new Map<string, FoundState>();
    let planned = false;
    // one page per viewport, opened and released in turn: a persistent profile allows one
    // context at a time, and a trigger shown at one width only is a state of that width
    for (const viewport of passes) {
      if (viewport.name === 'mobile' && !withStates) break;
      const opened = await openPage(opts.session, viewport);
      try {
        const page = opened.page;
        const response = await page
          .goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
          .catch(() => null);
        if (!response || response.status() >= 400) {
          if (viewport.name !== 'desktop') {
            console.warn(`${url}: mobile pass could not load, states discovered at desktop only`);
            break;
          }
          // a page is only planned once it answered, so one dead link in a nav costs that
          // page and nothing else
          const existing = manifest.units[id];
          if (existing && existing.status !== 'planned') break;
          const reason = response ? `http_${response.status()}` : ERROR_CODES.navigationFailed;
          manifest.units[id] = {
            kind: 'page',
            status: 'planned',
            url,
            dependsOn: [],
            rounds: 0,
            updatedAt: now(),
          };
          blockUnit(
            manifest,
            id,
            response
              ? {
                  code: reason,
                  message: `${url} answered http ${response.status()} during the crawl`,
                  hint: 'check the link that points at it, or drop this unit if the page is gone.',
                }
              : {
                  code: reason,
                  message: `${url} could not be loaded during the crawl`,
                  hint: 'check the url and the network, then re-explore, or drop this unit if the page is gone.',
                },
            now(),
          );
          break;
        }
        await page.waitForLoadState('load', { timeout: 60_000 }).catch(() => {});
        // claude: a mobile-only crawl is the follow-up once a real site hides pages behind a hamburger
        if (viewport.name === 'desktop') {
          if (!manifest.units[id]) {
            manifest.units[id] = {
              kind: 'page',
              status: 'planned',
              url,
              dependsOn: [],
              rounds: 0,
              updatedAt: now(),
            };
          }
          planned = true;
          if (depth < opts.depth) {
            const links: string[] = await page.evaluate(() =>
              Array.from(document.querySelectorAll('a[href]')).map(
                (a) => (a as HTMLAnchorElement).href,
              ),
            );
            for (const raw of links) {
              if (!/^https?:/.test(raw)) continue;
              const link = normalise(raw);
              if (seen.has(link) || !inScope(link, origin, opts.scope)) continue;
              if (ASSET_EXTENSIONS.test(new URL(link).pathname)) continue;
              seen.add(link);
              queue.push({ url: link, depth: depth + 1 });
            }
          }
        }
        if (withStates) {
          await settle(page);
          const dynamic = {
            shots: manifest.capture.dynamicShots,
            gap: manifest.capture.dynamicGap,
          };
          for (const state of await discoverStates(page, url, viewport, dynamic)) {
            recordState(found, viewport.name, state);
          }
        }
      } finally {
        await opened.release();
      }
    }
    if (!planned) continue;
    for (const [name, state] of found) {
      const sid = unitIdForState(slug, name);
      if (manifest.units[sid]) continue;
      manifest.units[sid] = {
        kind: 'state',
        status: 'planned',
        url,
        dependsOn: [id],
        rounds: 0,
        updatedAt: now(),
        ...unitActions(state),
        reachable: VIEWPORT_NAMES.filter((v) => state.reachable.includes(v)),
      };
    }
  }
  await saveManifest(opts.root, manifest);
  return manifest;
}
