export function slugFromUrl(url: string): string {
  const { pathname } = new URL(url);
  const trimmed = pathname.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return 'index';
  const slug = trimmed
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .split('/')
    .map((seg) => seg.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    .filter(Boolean)
    .join('--');
  return slug || 'index';
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** heading words kept in a section id, and the cap on their slug: ids become file names and data-section values. */
const SECTION_HEADING_WORDS = 5;
const SECTION_SLUG_MAX = 60;

export function sectionIdFor(order: number, role: string, heading: string): string {
  const n = String(order).padStart(2, '0');
  const head = slugify(heading)
    .split('-')
    .slice(0, SECTION_HEADING_WORDS)
    .join('-')
    .slice(0, SECTION_SLUG_MAX)
    .replace(/-$/, '');
  return head ? `s${n}-${role}-${head}` : `s${n}-${role}`;
}

/** fnv-1a 32-bit, hex. duplicated verbatim inside the in-page extractor. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function refFromPath(stablePath: string): string {
  return `r${fnv1a(stablePath)}`;
}

export function unitIdForPage(slug: string): string {
  return `page:${slug}`;
}

export function unitIdForSection(parentUnitId: string, sectionId: string): string {
  return `${parentUnitId}#${sectionId}`;
}

export type ParsedUnitId =
  | { kind: 'page'; slug: string }
  | { kind: 'section'; slug: string; sectionId: string; parent: string }
  | { kind: 'state'; slug: string; state: string }
  | { kind: 'flowStep'; flow: string; step: string };

/**
 * every segment of a unit id is a slug, which is what the helpers above build. a unit id
 * becomes a directory path, so a segment that is not one (`..`, an extra `/`, a capital)
 * is refused here rather than resolved on disk.
 */
const ID_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

export function parseUnitId(id: string): ParsedUnitId {
  const bad = () => new Error(`bad unit id: ${id}`);
  const hashes = id.split('#');
  if (hashes.length > 2) throw bad();
  const [head, sectionId] = hashes;
  if (!head) throw bad();
  // `page:x#` has a hash and nothing after it: neither a page nor a section
  if (sectionId === '') throw bad();
  const colon = head.indexOf(':');
  if (colon < 1) throw bad();
  const kind = head.slice(0, colon);
  const rest = head.slice(colon + 1);
  if (!rest) throw bad();
  if (sectionId !== undefined) {
    if (kind !== 'page') throw new Error(`sections under ${kind} are not supported yet: ${id}`);
    if (!ID_SEGMENT.test(rest) || !ID_SEGMENT.test(sectionId)) throw bad();
    return { kind: 'section', slug: rest, sectionId, parent: head };
  }
  if (kind === 'page') {
    if (!ID_SEGMENT.test(rest)) throw bad();
    return { kind: 'page', slug: rest };
  }
  if (kind === 'state' || kind === 'flow') {
    const parts = rest.split('/');
    if (parts.length !== 2) throw bad();
    const [first, second] = parts as [string, string];
    if (!ID_SEGMENT.test(first) || !ID_SEGMENT.test(second)) throw bad();
    return kind === 'state'
      ? { kind: 'state', slug: first, state: second }
      : { kind: 'flowStep', flow: first, step: second };
  }
  throw bad();
}

export function unitIdForState(slug: string, state: string): string {
  return `state:${slug}/${state}`;
}

/** `step-NN-<kind>-<up to four words of the target's name>`; NN is the 1-based position. */
export function stepSlug(n: number, kind: string, name: string): string {
  const nn = String(n).padStart(2, '0');
  const head = slugify(name).split('-').filter(Boolean).slice(0, 4).join('-');
  return head ? `step-${nn}-${kind}-${head}` : `step-${nn}-${kind}`;
}

export function unitIdForFlowStep(flow: string, step: string): string {
  return `flow:${flow}/${step}`;
}

/** a flow name is a dir name, a file name and a unit id segment: lowercase, digits, hyphens. */
export const FLOW_NAME = /^[a-z0-9][a-z0-9-]*$/;
