import path from 'node:path';
import { parseUnitId } from '../pack/ids';
import type { Manifest } from '../pack/schemas';

/**
 * landmarks the extractor lists as sections of their own. shared across pages they become one
 * layout under `src/components/layouts/`, so every unit that builds one of them works on the
 * same files: one place names them, and the scheduler, the allowed list and the generator all
 * read it from here.
 */
export const CHROME_ROLES = new Set(['header', 'nav', 'footer']);

/**
 * is this unit a section whose role is chrome? a section id is `s<NN>-<role>[-<heading>]`
 * (sectionIdFor), so the role is the second `-`-separated token; nothing else is chrome.
 */
export function isChromeSection(unitId: string): boolean {
  const p = parseUnitId(unitId);
  if (p.kind !== 'section') return false;
  return CHROME_ROLES.has(p.sectionId.split('-')[1] ?? '');
}

/**
 * one url path segment as a directory name. a segment is decoded so a route dir reads as the
 * url does, but the raw segment is kept whenever decoding it would not be a single dir name:
 * `%zz` is not decodable at all, `%2F` would split one segment into two (and two source urls
 * could then collide on one dir), and `.` or `..` would climb out of src/app. whitespace in a
 * decoded segment becomes a hyphen; a directory with a space in it is nobody's route.
 */
function routeSegment(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return raw;
  }
  if (/[/\\]/.test(decoded) || decoded === '.' || decoded === '..') return raw;
  return decoded.replace(/\s+/g, '-');
}

/**
 * the route dir for a page url, in the app router: `/` is src/app, `/blog/x` is src/app/blog/x.
 * a path with an extension keeps it as the folder name (`src/app/about.html` serves
 * `/about.html`; probed on next 14.2.35). the query and the fragment are not part of a route.
 */
export function routeDirFor(url: string): string {
  const pathname = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
  const segments = pathname.split('/').filter(Boolean).map(routeSegment);
  return path.posix.join('src/app', ...segments);
}

/** the feature a unit's components live in: its page's slug, or its flow's name */
export function featureFor(unitId: string): string {
  const p = parseUnitId(unitId);
  return p.kind === 'flowStep' ? p.flow : p.slug;
}

/**
 * `s02-hero-know-before-you-go` becomes `S02HeroKnowBeforeYouGo`: a section id as a component
 * name. a name a digit would start (`2fa-open`) is not a javascript identifier, so it takes a
 * `U` in front of it.
 */
export function componentNameFor(id: string): string {
  const name = id
    .split('-')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('');
  return /^[0-9]/.test(name) ? `U${name}` : name;
}

function urlOf(manifest: Manifest, unitId: string): string {
  const u = manifest.units[unitId];
  if (!u?.url) throw new Error(`${unitId} has no url in the manifest`);
  return u.url;
}

/**
 * the file a unit's worker builds, relative to the project (spec section 7): one component per
 * section under its page's feature, the route for a page, the page's components dir for a
 * state (a state is behaviour of the page's components), one component per flow step.
 */
export function componentFileFor(manifest: Manifest, unitId: string): string {
  const p = parseUnitId(unitId);
  switch (p.kind) {
    case 'section':
      return path.posix.join('src/features', p.slug, 'components', `${p.sectionId}.tsx`);
    case 'page':
      return path.posix.join(routeDirFor(urlOf(manifest, unitId)), 'page.tsx');
    case 'state':
      return path.posix.join('src/features', p.slug, 'components');
    case 'flowStep':
      return path.posix.join('src/features', p.flow, 'components', `${p.step}.tsx`);
  }
}

/** the route a unit renders through: its page's, or for a flow step the route of the step's own url */
export function routeFileFor(manifest: Manifest, unitId: string): string {
  const p = parseUnitId(unitId);
  const pageId = p.kind === 'section' ? p.parent : p.kind === 'state' ? `page:${p.slug}` : unitId;
  return path.posix.join(routeDirFor(urlOf(manifest, pageId)), 'page.tsx');
}

/**
 * what a worker may edit, absolute, dirs ending in a slash: the unit's own file (or dir), its
 * route, its whole feature, the shared primitives and the error components, and the assets.
 * never bare `src/components/`: the shared chrome under `src/components/layouts/` is one file
 * every page renders, so only a chrome section may edit it, and a dir entry that contained it
 * would hand it to every unit by prefix. never the theme (`tailwind.config.cjs`) and never
 * `src/styles/`: both are generated from the pack and shared by every worker, two builders
 * under `parallel: 2` writing one of them would leave the last writer's, and the pack's
 * colours, font families, keyframes and animation shorthands are in the theme already
 * (tokensFrom); a measurement the theme lacks is an arbitrary value, and a keyframe the pack
 * never captured is a plain css file in the feature. resolved against the cwd, because a
 * relative project would leave the hook comparing relative prefixes against the absolute
 * paths a tool call carries.
 */
export function allowedFilesFor(manifest: Manifest, unitId: string, project: string): string[] {
  const own = componentFileFor(manifest, unitId);
  const entries = [
    path.resolve(project, own) + (own.endsWith('.tsx') ? '' : '/'),
    path.resolve(project, routeFileFor(manifest, unitId)),
    path.resolve(project, 'src/features', featureFor(unitId)) + '/',
    ...(isChromeSection(unitId) ? [path.resolve(project, 'src/components/layouts') + '/'] : []),
    path.resolve(project, 'src/components/ui') + '/',
    path.resolve(project, 'src/components/errors') + '/',
    path.resolve(project, 'src/assets') + '/',
  ];
  return [...new Set(entries)];
}
