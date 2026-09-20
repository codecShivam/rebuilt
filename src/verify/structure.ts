import type { Section, SectionsFile, VerifyResult } from '../pack/schemas';

export type StructureFinding = VerifyResult['structure'][number];
type Finding = StructureFinding;

export function matchSection(source: Section, ours: SectionsFile): Section | undefined {
  return (
    ours.find((s) => s.dataSection === source.id) ??
    ours.find((s) => s.path === source.path) ??
    ours[source.order - 1]
  );
}

/**
 * ours' text the way the source would say it. brand normalisation (spec section 6, phase two
 * only) is a function over strings: the headings, the item titles and descriptions and the
 * button labels of ours go through it before they are compared, and nothing else does (an id,
 * a path and a count are not words). the default is the identity, so without a brand the
 * comparison is exact and byte for byte what it was.
 */
function normalised(ours: SectionsFile, normalise: (s: string) => string): SectionsFile {
  return ours.map((s) => ({
    ...s,
    heading: normalise(s.heading),
    items: s.items.map((i) => ({
      ...i,
      title: normalise(i.title),
      description: normalise(i.description),
    })),
    buttons: s.buttons.map(normalise),
  }));
}

export function compareStructure(
  source: SectionsFile,
  theirs: SectionsFile,
  only?: string,
  normalise: (s: string) => string = (s) => s,
): Finding[] {
  const ours = normalised(theirs, normalise);
  const findings: Finding[] = [];
  const sections = only ? source.filter((s) => s.id === only) : source;
  if (!only && source.length !== ours.length) {
    findings.push({
      kind: 'count',
      expected: `${source.length} sections`,
      actual: `${ours.length} sections`,
      where: 'page',
    });
  }
  for (const s of sections) {
    const o = matchSection(s, ours);
    if (!o) {
      findings.push({
        kind: 'heading',
        expected: s.heading,
        actual: '(missing section)',
        where: s.id,
      });
      continue;
    }
    if (s.heading !== o.heading)
      findings.push({ kind: 'heading', expected: s.heading, actual: o.heading, where: s.id });
    const exp = s.items.map((i) => `${i.title} | ${i.description}`);
    const act = o.items.map((i) => `${i.title} | ${i.description}`);
    for (const e of exp)
      if (!act.includes(e))
        findings.push({ kind: 'item', expected: e, actual: '(missing)', where: s.id });
    for (const a of act)
      if (!exp.includes(a))
        findings.push({ kind: 'item', expected: '(none)', actual: a, where: s.id });
    if (
      exp.length === act.length &&
      exp.some((e, i) => e !== act[i]) &&
      exp.every((e) => act.includes(e))
    ) {
      findings.push({
        kind: 'item',
        expected: exp.join(' / '),
        actual: act.join(' / '),
        where: `${s.id} (order)`,
      });
    }
    for (const b of s.buttons)
      if (!o.buttons.includes(b))
        findings.push({ kind: 'button', expected: b, actual: '(missing)', where: s.id });
    if (s.imageCount !== o.imageCount)
      findings.push({
        kind: 'count',
        expected: `${s.imageCount} images`,
        actual: `${o.imageCount} images`,
        where: s.id,
      });
    if (s.svgCount !== o.svgCount)
      findings.push({
        kind: 'count',
        expected: `${s.svgCount} svgs`,
        actual: `${o.svgCount} svgs`,
        where: s.id,
      });
  }
  return findings;
}
