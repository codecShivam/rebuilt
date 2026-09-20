import path from 'node:path';
import type { Session } from '../capture/session';
import { PER_UNIT_ERROR_CODES } from '../pack/defaults';
import { loadManifest, readJson } from '../pack/io';
import { PackPaths, UNIT_FILES } from '../pack/paths';
import { SectionsFileSchema, type Brand, type SectionsFile } from '../pack/schemas';
import { captureOurs } from './capture-ours';
import { compareStructure, type StructureFinding } from './structure';

/** a table of whole-word substitutions: what to find, what to write in its place */
export type Substitutions = Record<string, string>;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * every key of the table replaced where it stands as a whole word: a letter, a digit or an
 * underscore on either side means it is part of a longer word (`Fixture` leaves `FixtureHero`
 * alone; a hyphen is not a word character, so it does not leave `s02-fixture` alone, which is
 * why the codemod fences its paths first). a combining mark is a word character too, so text
 * that arrives decomposed (nfd) reads as its reader sees it: `Fixtur` + `e` + a combining
 * acute is one word, not `Fixture` followed by something. longest key first, so `Fixture Co`
 * wins over `Fixture`. the match is case-insensitive and the match's case picks the
 * replacement's: the key as written gets the value as written, the key in lower case the value
 * in lower case, in upper case the value in upper case; any other casing is left as it is and
 * not counted.
 */
export function substitute(
  text: string,
  table: Substitutions,
): { text: string; counts: Record<string, number> } {
  const keys = Object.keys(table).sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const counts: Record<string, number> = {};
  if (!keys.length) return { text, counts };
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}_])(?:${keys.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}\\p{M}_])`,
    'giu',
  );
  const byLower = new Map(keys.map((k) => [k.toLowerCase(), k]));
  const out = text.replace(re, (m) => {
    const key = byLower.get(m.toLowerCase());
    if (key === undefined) return m;
    const value = table[key]!;
    let replacement: string;
    if (m === key) replacement = value;
    else if (m === key.toLowerCase()) replacement = value.toLowerCase();
    else if (m === key.toUpperCase()) replacement = value.toUpperCase();
    else return m;
    counts[key] = (counts[key] ?? 0) + 1;
    return replacement;
  });
  return { text: out, counts };
}

/**
 * the source value a theme colour token stands for. tokensFrom names every colour token after
 * its source value (`pack-2563eb` is `#2563eb`, `pack-000000-50` is `rgba(0, 0, 0, 0.5)`), so
 * the name is enough to come back from a brand override. the suffix is the alpha as a whole
 * percent and comes back divided by a hundred: `-50` is `0.5` and `-5` is `0.05`.
 */
export function sourceColourOf(token: string): string {
  const m = /^pack-([0-9a-f]{6})(?:-(\d{1,3}))?$/.exec(token);
  if (!m) throw new Error(`${token} is not a pack colour token`);
  if (m[2] === undefined) return `#${m[1]}`;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${Number(m[2]) / 100})`;
}

/**
 * two brand strings that differ only by case cannot both be inverted, because the match is
 * case-insensitive. `BrandSchema` refuses such a brand on read; this is the same refusal for
 * a table built in code, so neither road can drop a source string quietly. it carries no
 * `code`: an error with a code is a per-unit capture failure (see `PER_UNIT_ERROR_CODES`),
 * and a brand that contradicts itself is a bad input, not a page that would not load.
 */
export class BrandCollisionError extends Error {
  constructor(
    readonly first: string,
    readonly second: string,
  ) {
    super(
      `the brand says "${first}" and "${second}", which differ only by case; the substitution is case-insensitive, so they cannot both be mapped back`,
    );
    this.name = 'BrandCollisionError';
  }
}

/**
 * brand normalisation (spec section 6): the map from a branded string back to the source's,
 * so the structure diff reads ours as the source would have said it. a name comes back
 * through the same whole-word rule the codemod applied it with; a brand family comes back as
 * the source family; a brand colour value comes back as the value its token's name spells.
 * two source strings branded to the same string come back as the first of them: the diff then
 * names the other, which is the honest answer. two that differ only by case are not that case
 * and throw, because the inverted table could keep only one of them and nothing would say so.
 */
export function unbrand(brand: Brand): (text: string) => string {
  const table: Substitutions = {};
  const seen = new Map<string, string>();
  const put = (from: string, to: string) => {
    const first = seen.get(from.toLowerCase());
    if (first === undefined) {
      seen.set(from.toLowerCase(), from);
      table[from] = to;
      return;
    }
    if (first !== from) throw new BrandCollisionError(first, from);
    // the same brand string twice, spelled the same way: the first source wins, as documented
  };
  for (const [source, branded] of Object.entries(brand.names)) put(branded, source);
  for (const [source, font] of Object.entries(brand.fonts)) put(font.family, source);
  for (const [token, value] of Object.entries(brand.colors)) put(value, sourceColourOf(token));
  return (text) => substitute(text, table).text;
}

export interface GateUnit {
  unitId: string;
  findings: StructureFinding[];
}

/** a page unit the gate had nothing to compare, and why: no url on the unit, or no sections.json on disk (blocked before capture) */
export interface GateSkip {
  unitId: string;
  reason: string;
}

export interface GateResult {
  verdict: 'pass' | 'fail';
  units: GateUnit[];
  /** the page units nothing was compared for, each with its reason */
  skipped: GateSkip[];
}

/**
 * the brand phase's gate (spec section 7): the structure diff over every captured page of the
 * pack, ours captured from the target the way verify captures it, under brand normalisation
 * when a brand is given and exact otherwise. pixels, styles and animations are not looked at.
 * a page ours cannot reach fails with the reason as its one finding; anything uncoded is a
 * bug and throws. states and flow steps are not walked: their words are their page's.
 */
export async function gateStructure(opts: {
  root: string;
  target: string;
  session: Session;
  brand: Brand | null;
  log?: (line: string) => void;
}): Promise<GateResult> {
  const manifest = await loadManifest(opts.root);
  const pack = new PackPaths(opts.root);
  const normalise = opts.brand ? unbrand(opts.brand) : undefined;
  const units: GateUnit[] = [];
  const skipped: GateSkip[] = [];
  const pages = Object.entries(manifest.units)
    .filter(([, u]) => u.kind === 'page')
    .map(([unitId, u]) => ({ unitId, url: u.url }))
    .sort((a, b) => (a.unitId < b.unitId ? -1 : 1));
  for (const { unitId, url } of pages) {
    // a page with no url was never captured, so there is nothing of the source to compare
    // ours against; it is named here rather than passed over in silence
    if (!url) {
      skipped.push({ unitId, reason: 'no url' });
      continue;
    }
    let source: SectionsFile;
    try {
      source = await readJson(
        SectionsFileSchema,
        path.join(pack.unitDir(unitId), UNIT_FILES.sections),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      skipped.push({ unitId, reason: 'no sections.json' });
      continue;
    }
    opts.log?.(`${unitId}: capturing ours at ${opts.target}`);
    let ours: Awaited<ReturnType<typeof captureOurs>>;
    try {
      ours = await captureOurs({
        root: opts.root,
        manifest,
        unitId,
        target: opts.target,
        session: opts.session,
      });
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (!code || !PER_UNIT_ERROR_CODES.includes(code)) throw err;
      units.push({
        unitId,
        findings: [
          {
            kind: 'text',
            expected: 'a page ours can reach',
            actual: `ours: ${code}: ${(err as Error).message}`,
            where: 'page',
          },
        ],
      });
      continue;
    }
    try {
      units.push({
        unitId,
        findings: compareStructure(source, ours.summary.sections, undefined, normalise),
      });
    } finally {
      await ours.cleanup();
    }
  }
  return {
    verdict: units.every((u) => u.findings.length === 0) ? 'pass' : 'fail',
    units,
    skipped,
  };
}
