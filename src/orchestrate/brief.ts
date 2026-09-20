import path from 'node:path';
import { VIEWPORT_NAMES, type ViewportName } from '../pack/defaults';
import { parseUnitId, slugify } from '../pack/ids';
import { readJson } from '../pack/io';
import { PackPaths, UNIT_FILES } from '../pack/paths';
import {
  AnimationsFileSchema,
  PageMetaSchema,
  SectionsFileSchema,
  StylesFileSchema,
  type Action,
  type AnimationsFile,
  type Manifest,
  type PageMeta,
  type Rect,
  type Section,
  type SectionsFile,
  type StylesFile,
  type VerifyResult,
  type WorkerOutput,
} from '../pack/schemas';
import { summarise } from '../verify/report';
import { briefHeader } from './brief-header';
import { allowedFilesFor, componentFileFor, isChromeSection, routeFileFor } from './layout';
import { colourToken } from './scaffold/generate';

export { briefHeader, parseBriefHeader } from './brief-header';

// the wording below was written for the real model (milestone 5); the facts a brief carries and
// the two gate rules (font family names, global keyframe names) are the gates' and do not move

/**
 * the one sentence that keeps a worker's own `site shot` and `site verify` on the allowlist and
 * out of the pack. the rules match the text of the command: on run 2 of the real binary every
 * denied call was the printed command decorated (the paths in double quotes, `cd … &&` in
 * front, an absolute `/Users/…/bin/site`, `2>&1 | head -100` after), and the final real run's
 * one denial was `site verify … ; echo "EXIT:$?"`, a chain the sentence had not named. the
 * quoting variants the rules now carry (verifyRuleFor, shotRuleFor) cannot cover the rest,
 * because the binary splits on `;`, `&&` and `|` and judges each part. the tail matters as
 * much as the head: `--out` is already printed on the shot command, and a second one pointed
 * into the pack would have verify clearing artefacts in a dir the capture lives in.
 */
const EXACTLY_AS_PRINTED =
  'run it exactly as printed, character for character: no quotes around the paths, no `cd` in front, no other spelling of the binary, no flag added, moved or dropped (`--out` included), nothing piped or redirected after, no `;` or `&&` chaining before or after; the allowlist matches the text, and anything else is denied';

/** what the last finished round left: the verify result, the reviewer's reasons, the one-line reason */
export interface PreviousRound {
  verify: VerifyResult | null;
  reviewerReasons: string[];
  reason: string | null;
}

export interface BriefInput {
  root: string;
  manifest: Manifest;
  unitId: string;
  round: number;
  rounds: number;
  project: string;
  target: string;
  threshold: number;
  /** round-N/shots: where the worker's own `site shot` writes */
  shotsDir: string;
  previous: PreviousRound | null;
}

/** elements inlined per viewport; the rest stay in styles.json, which the brief names */
const BRIEF_MAX_ELEMENTS = 80;

interface UnitPack {
  unitDir: string;
  sections: SectionsFile;
  styles: StylesFile;
  animations: AnimationsFile;
  meta: PageMeta;
}

async function readUnit(root: string, unitId: string): Promise<UnitPack> {
  const unitDir = new PackPaths(root).unitDir(unitId);
  return {
    unitDir,
    sections: await readJson(SectionsFileSchema, path.join(unitDir, UNIT_FILES.sections)),
    styles: await readJson(StylesFileSchema, path.join(unitDir, UNIT_FILES.styles)),
    animations: await readJson(AnimationsFileSchema, path.join(unitDir, UNIT_FILES.animations)),
    meta: await readJson(PageMetaSchema, path.join(unitDir, UNIT_FILES.meta)),
  };
}

function box(r: Rect | null): string {
  return r ? `x ${r.x}, y ${r.y}, w ${r.width}, h ${r.height}` : 'not captured';
}

function fence(value: unknown): string {
  return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
}

function describeAction(a: Action): string {
  const t = a.target;
  const name = t ? (t.role ? `${t.role.role} "${t.role.name}"` : (t.text ?? t.css)) : '';
  return name ? `${a.kind} ${name}` : a.kind;
}

/** the elements a unit's worker is responsible for: a section's subtree, or everything */
function within(section: Section | undefined): (p: string) => boolean {
  return section ? (p) => p === section.path || p.startsWith(section.path + '>') : () => true;
}

function sectionLine(s: Section): string {
  const heading = s.heading ? ` "${s.heading}"` : '';
  return `\`${s.id}\` (${s.role}${heading}; mobile ${box(s.bbox.mobile)}; desktop ${box(s.bbox.desktop)})`;
}

/**
 * the pngs the capture left for this unit. a section's crop exists only at a viewport where the
 * section had a box, so a null box names no crop, and a state its discovery pass reached at one
 * viewport only has no full page at the other: a brief that pointed at a png that is not there
 * would send the worker looking for it. `reachable` absent means every viewport.
 */
function shots(
  pack: PackPaths,
  unitDir: string,
  section: Section | undefined,
  reachable: ViewportName[] | undefined,
): string[] {
  const lines: string[] = [];
  for (const vp of VIEWPORT_NAMES) {
    if (reachable && !reachable.includes(vp)) continue;
    const vdir = pack.viewportDir(unitDir, vp);
    if (section?.bbox[vp]) {
      lines.push(`- ${vp} crop: ${path.join(vdir, UNIT_FILES.section(section.id))}`);
    }
    lines.push(`- ${vp} full page: ${path.join(vdir, UNIT_FILES.full)}`);
  }
  return lines;
}

function fontLines(meta: PageMeta): string[] {
  const lines = meta.fonts.map((f) =>
    f.file
      ? `- ${f.family} ${f.weight} ${f.style} -> src/assets/fonts/${f.file} (declared in src/styles/fonts.css; keep the family name \`${f.family}\`)`
      : `- ${f.family} ${f.weight} ${f.style}: a system font, no file`,
  );
  return lines.length ? lines : ['- none captured'];
}

/** the classes the generated theme already answers to: a worker reaches for these before an arbitrary value */
function themeLines(unit: UnitPack, keep: (p: string) => boolean): string[] {
  const colours = unit.meta.colours
    .map((c) => colourToken(c))
    .filter((t): t is { name: string; value: string } => t !== null)
    .map((t) => `\`${t.name}\` (${t.value})`);
  const fonts = [...new Set(unit.meta.fonts.map((f) => slugify(f.family) || 'sans'))];
  const names = new Set<string>();
  for (const vp of VIEWPORT_NAMES) {
    for (const [p, el] of Object.entries(unit.animations.elements[vp])) {
      if (!keep(p)) continue;
      for (const n of (el.animation?.['animation-name'] ?? '').split(',')) {
        const name = n.trim();
        if (name && name !== 'none') names.add(name);
      }
    }
  }
  return [
    `   - colours, as \`bg-<name>\`, \`text-<name>\`, \`border-<name>\`: ${colours.join(', ') || 'none'}`,
    `   - font families, as \`font-<name>\`: ${fonts.map((f) => `\`font-${f}\``).join(', ') || 'none'}`,
    `   - animations, as \`animate-<name>\` (the source's keyframes, duration, easing, delay and count by name): ${[...names].map((n) => `\`animate-${n}\``).join(', ') || 'none in this unit'}`,
  ];
}

/** do two rects overlap at all? a mask that only touches a section's edge is not inside it */
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * how many regions the pixel comparison ignores in this unit at each viewport, and what to do
 * about them. the masks are the page's, so a section is counted only the ones that fall in its
 * own box: the page's count would have a worker hunting a carousel three sections above it. a
 * section with no box at a viewport has no masked region there either.
 */
function masksLine(meta: PageMeta, section: Section | undefined): string {
  const counts = VIEWPORT_NAMES.map((vp) => {
    const box = section?.bbox[vp];
    const n = section
      ? box
        ? meta.masks[vp].filter((m) => overlaps(m, box)).length
        : 0
      : meta.masks[vp].length;
    return `${vp} ${n}`;
  }).join(', ');
  return `${counts}; render what the source shows at rest there (a counter's first value, a video's poster); the pixels are not compared but the element and its styles are`;
}

/** the unit as the brief describes it, by kind */
function describeUnit(
  pack: PackPaths,
  manifest: Manifest,
  unitId: string,
  unit: UnitPack,
  section: Section | undefined,
): string[] {
  const p = parseUnitId(unitId);
  const lines: string[] = [];
  switch (p.kind) {
    case 'section':
      lines.push(`- a section of the page at ${manifest.units[p.parent]?.url ?? '?'}`);
      lines.push(`- section id: ${sectionLine(section!)}`);
      if (section!.items.length) {
        lines.push('- items (title | description):');
        for (const i of section!.items) lines.push(`  - ${i.title} | ${i.description}`);
      }
      if (section!.buttons.length) lines.push(`- buttons: ${section!.buttons.join(', ')}`);
      lines.push(`- images: ${section!.imageCount}, svgs: ${section!.svgCount}`);
      if (isChromeSection(unitId)) {
        lines.push(
          `- shared chrome: every page renders this ${section!.role} from \`src/components/layouts/site-${section!.role}.tsx\`, which the component file wraps with this page's section id`,
        );
      }
      break;
    case 'page':
      lines.push(
        `- the whole page at ${manifest.units[unitId]?.url ?? '?'}: every section in order, and the spacing between sections (a whole-page diff catches what the section diffs cannot)`,
      );
      unit.sections.forEach((s, i) => lines.push(`${i + 1}. ${sectionLine(s)}`));
      break;
    case 'state': {
      const actions = manifest.units[unitId]?.actions ?? [];
      lines.push(
        `- an interactive state of the page at ${manifest.units[unitId]?.url ?? '?'}, reached by: ${actions.map(describeAction).join(', then ') || '(no actions recorded)'}`,
      );
      lines.push(
        '- the rebuild must reach the same state through the same actions (the same role and accessible name on the trigger), and look the same once there',
      );
      unit.sections.forEach((s, i) => lines.push(`${i + 1}. ${sectionLine(s)}`));
      break;
    }
    case 'flowStep': {
      const n = Number(/^step-(\d+)/.exec(p.step)?.[1] ?? 0);
      lines.push(
        `- step ${n} of flow \`${p.flow}\`: the page after the recorded steps up to this one are replayed from ${manifest.units[unitId]?.url ?? '?'} (the steps are in ${pack.stepsFile(p.flow)})`,
      );
      unit.sections.forEach((s, i) => lines.push(`${i + 1}. ${sectionLine(s)}`));
      break;
    }
  }
  return lines;
}

/** the ref table and the inlined styles for the elements the worker is responsible for */
function elementsBlock(unit: UnitPack, keep: (p: string) => boolean): string[] {
  const lines: string[] = [];
  const paths = new Set<string>();
  for (const vp of VIEWPORT_NAMES)
    for (const p of Object.keys(unit.styles[vp])) if (keep(p)) paths.add(p);
  const sorted = [...paths].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
  lines.push('| path | ref | tag |', '|---|---|---|');
  for (const p of sorted.slice(0, BRIEF_MAX_ELEMENTS)) {
    const el = unit.styles.desktop[p] ?? unit.styles.mobile[p]!;
    lines.push(`| \`${p}\` | \`${el.ref}\` | ${el.tag} |`);
  }
  if (sorted.length > BRIEF_MAX_ELEMENTS) {
    lines.push(`| ... ${sorted.length - BRIEF_MAX_ELEMENTS} more in styles.json | | |`);
  }
  for (const vp of VIEWPORT_NAMES) {
    const entries = Object.fromEntries(
      sorted
        .slice(0, BRIEF_MAX_ELEMENTS)
        .filter((p) => unit.styles[vp][p])
        .map((p) => [
          p,
          {
            ref: unit.styles[vp][p]!.ref,
            tag: unit.styles[vp][p]!.tag,
            styles: unit.styles[vp][p]!.styles,
          },
        ]),
    );
    if (Object.keys(entries).length) lines.push('', `### computed styles (${vp})`, fence(entries));
  }
  const animated: Record<string, unknown> = {};
  const names = new Set<string>();
  for (const vp of VIEWPORT_NAMES) {
    for (const [p, el] of Object.entries(unit.animations.elements[vp])) {
      if (!keep(p)) continue;
      animated[`${vp} ${p}`] = el;
      for (const n of (el.animation?.['animation-name'] ?? '').split(',')) {
        const name = n.trim();
        if (name && name !== 'none') names.add(name);
      }
    }
  }
  const keyframes = Object.fromEntries(
    [...names]
      .filter((n) => unit.animations.keyframes[n])
      .map((n) => [n, unit.animations.keyframes[n]]),
  );
  if (Object.keys(animated).length) {
    lines.push(
      '',
      '### animations and transitions (exact: longhands, and keyframes by name)',
      fence({ keyframes, elements: animated }),
    );
  }
  return lines;
}

function previousBlock(previous: PreviousRound | null): string[] {
  if (!previous) return [];
  const lines = ['## the previous round', ''];
  if (previous.reason) lines.push(`it failed: ${previous.reason}`, '');
  if (previous.verify) {
    // summarise already lists every style, animation and missing finding; repeating them as
    // bullets under it only makes the brief longer
    lines.push('verify said:', '', '```', summarise(previous.verify), '```', '');
    lines.push('look at these before you change anything:');
    for (const a of previous.verify.artefacts) lines.push(`- ${a}`);
  }
  if (previous.reviewerReasons.length) {
    lines.push('', 'the reviewer rejected it for:');
    for (const r of previous.reviewerReasons) lines.push(`- ${r}`);
  }
  lines.push('');
  return lines;
}

/**
 * the builder's brief: the unit, where the pack's evidence is, how to work (look, write with
 * the theme's classes, shoot, gate, check), the refs it must carry, the styles and animations
 * it must match, the fonts, the previous round, and the rules. every path is absolute; the
 * worker gets the pack root through --add-dir.
 */
export async function builderBrief(input: BriefInput): Promise<string> {
  const pack = new PackPaths(input.root);
  const unit = await readUnit(input.root, input.unitId);
  const p = parseUnitId(input.unitId);
  const section =
    p.kind === 'section' ? unit.sections.find((s) => s.id === p.sectionId) : undefined;
  if (p.kind === 'section' && !section) throw new Error(`${p.sectionId} is not in the pack`);
  const component = componentFileFor(input.manifest, input.unitId);
  const route = routeFileFor(input.manifest, input.unitId);
  const allowed = allowedFilesFor(input.manifest, input.unitId, input.project);
  const keep = within(section);
  const kind = p.kind === 'flowStep' ? 'flow step' : p.kind;
  const verifyCommand = `site verify --pack ${input.root} --unit ${input.unitId} --target ${input.target} --gate ${input.threshold}`;
  const shotCommand = `site shot --pack ${input.root} --unit ${input.unitId} --target ${input.target} --out ${input.shotsDir}`;
  const lines: string[] = [
    briefHeader('builder', input.unitId, input.round),
    `# build ${input.unitId} (round ${input.round} of ${input.rounds})`,
    '',
    '## the task',
    '',
    `build, or fix, this ${kind} in the next.js rebuild at ${input.project} until \`site verify\` passes: mismatched pixels at or under ${input.threshold} of the compared pixels (masks applied) at every captured viewport, every listed element's computed styles matching the pack, and its animations matching exactly. the source is the truth: copy it, do not improve it, do not invent content, and do not touch what is not yours.`,
    '',
    '## the unit',
    '',
    ...describeUnit(pack, input.manifest, input.unitId, unit, section),
    ...(isChromeSection(input.unitId)
      ? [
          '- build it in that layout file: the markup and the styles go there, and the component file only wraps it with the section id',
        ]
      : []),
    `- component file: ${component}${p.kind === 'state' ? " (the page's components; the state is their behaviour)" : ''}`,
    `- route file: ${route}`,
    `- the dev server: ${input.target} (running already, reloads on save; never start one)`,
    '',
    '## the pack',
    '',
    `- unit dir: ${unit.unitDir}`,
    `- sections: ${path.join(unit.unitDir, UNIT_FILES.sections)}`,
    `- computed styles per element and viewport, keyed by stable path: ${path.join(unit.unitDir, UNIT_FILES.styles)}`,
    `- animations: ${path.join(unit.unitDir, UNIT_FILES.animations)}`,
    `- masks, fonts, colours: ${path.join(unit.unitDir, UNIT_FILES.meta)}`,
    `- text in dom order: ${path.join(unit.unitDir, UNIT_FILES.text)}; the dom: ${path.join(unit.unitDir, UNIT_FILES.dom)}`,
    `- assets (index.json maps url to file): ${pack.assetsDir(unit.unitDir)}`,
    ...shots(pack, unit.unitDir, section, input.manifest.units[input.unitId]?.reachable),
    '',
    '## how to work',
    '',
    `1. look before you write: Read the source pngs above (Read shows an image), then Grep the dom for ${section ? `\`${section.selector}\`` : 'each section'} and read the computed styles below. the markup and the numbers are the spec; the png is what it must look like.`,
    '2. write the component with tailwind classes. the theme (`tailwind.config.cjs`) and the global styles (`src/styles/`, globals and fonts) are generated from the pack and read-only: nothing new goes in either, a measurement the theme lacks is an arbitrary value, and a font is one of the `@font-face` families declared there already. the theme has:',
    ...themeLines(unit, keep),
    '   every other measurement is an arbitrary value with the exact px from the computed styles: `text-[48px]`, `px-[32px]`, `mt-[16px]`, `rounded-[12px]`, `max-w-[480px]`, `leading-[56px]`, `gap-[24px]`, `shadow-[0_8px_24px_rgba(0,0,0,0.15)]`.',
    "3. images and svgs: `import hero from '@/assets/<file>'` and `<img src={hero.src} width={480} height={270} alt=\"...\" />`, the file name from assets/index.json (by the source url) and the width and height from the source markup; an inline svg is copied as jsx. never `next/image`, never the source site's url.",
    `4. after every change, look at your work: \`${shotCommand}\` writes ${input.shotsDir}/<viewport>.full.png${section ? ` and ${input.shotsDir}/<viewport>.${section.id}.png` : ''}; Read them next to the source pngs and fix what differs. ${EXACTLY_AS_PRINTED}.`,
    `5. gate it yourself: \`${verifyCommand}\` prints the pixel score per viewport, every style and animation finding (element, property, expected, actual), and names a diff png with the mismatches in red. a height delta means the ${section ? 'section' : 'page'} is taller or shorter than the source. ${EXACTLY_AS_PRINTED}.`,
    '6. before you stop: `npx tsc --noEmit` and `npx next lint` in the project, and fix what they report.',
    '7. when you stop, a Stop hook runs the same verify once more; while it fails you get the findings back and are asked to continue, a few times per round; then the orchestrator verifies and reviews on its own. do not argue with a finding: fix what it names.',
    '',
    '## elements and refs',
    '',
    'every element below exists in the source at the stable path shown. the element that stands for it in the rebuild carries `data-ref="<ref>"`; the verifier finds it by that attribute and compares the computed styles property by property (colours as rgb, lengths within one px, font family by name). an element without its data-ref is a missing element.',
    '',
    ...elementsBlock(unit, keep),
    '',
    '## fonts and colours',
    '',
    ...fontLines(unit.meta),
    `- colours seen on the page: ${unit.meta.colours.join(', ') || 'none'}`,
    `- regions masked out of the pixel comparison: ${masksLine(unit.meta, section)}`,
    '',
    ...previousBlock(input.previous),
    '## rules',
    '',
    `1. touch only these files and dirs (a shared primitive goes in \`src/components/ui/\`; the header, nav and footer every page renders live in \`src/components/layouts/\` and only a chrome section may edit them):`,
    ...allowed.map((f) => `   - ${f}`),
    section
      ? `2. the section root carries \`data-section="${section.id}"\`; every element listed above carries its \`data-ref\`; a section is a direct child of \`<main>\` (or a \`<header>\`, \`<nav>\`, \`<footer>\`), at least 80px tall`
      : '2. every section root carries its `data-section`; every element in the pack carries its `data-ref`; sections are direct children of `<main>` (or a `<header>`, `<nav>`, `<footer>`)',
    "3. animations: the theme's `animate-<name>` classes carry the source's keyframe names, durations, easings and delays; a keyframe the theme lacks goes in a plain css file in your feature dir, imported by your component, under the source's own name, never in a css module (next hashes a module's keyframe names and the animations gate matches by name)",
    "4. fonts: the theme's `font-<family>` classes, or `font-['Family Name']`; the faces are declared in the read-only `src/styles/fonts.css` under the source's family names already; never `next/font` (it renames the family, and the style gate compares computed font family names)",
    `5. run nothing but \`npx tsc --noEmit\`, \`npx next lint\`, the \`site shot\` and the \`site verify\` written above: no \`npm run dev\`, no \`npm install\`, no \`git\`. for those two commands, ${EXACTLY_AS_PRINTED}`,
    `6. the gate is \`${verifyCommand}\`; the Stop hook runs it for you and shows the scores and the diff images while it fails`,
    '7. when you stop, answer with one json object and nothing else: `{"summary": "<what you built>", "filesTouched": ["<relative paths>"], "notes": "<what did not fit, if anything>"}`',
    '',
  ];
  return lines.join('\n');
}

/**
 * the reviewer's brief: read-only, the same evidence plus what verify produced, how to look,
 * and the verdict shape. it is asked for what numbers miss: a wrong image, an unbuilt state,
 * a modal that behaves differently, text that differs, an item missing.
 */
export async function reviewerBrief(
  input: BriefInput & { verify: VerifyResult; builder: WorkerOutput | null },
): Promise<string> {
  const pack = new PackPaths(input.root);
  const unit = await readUnit(input.root, input.unitId);
  const p = parseUnitId(input.unitId);
  const section =
    p.kind === 'section' ? unit.sections.find((s) => s.id === p.sectionId) : undefined;
  if (p.kind === 'section' && !section) throw new Error(`${p.sectionId} is not in the pack`);
  const kind = p.kind === 'flowStep' ? 'flow step' : p.kind;
  const url = input.manifest.units[p.kind === 'section' ? p.parent : input.unitId]?.url ?? '?';
  // what ours looked like is whatever verify copied into its outDir, named `ours.<vp>.<label>`
  // (see oursPngName): listing the artefacts it wrote never names a png that is not there, and
  // never names one twice
  const isOurs = (f: string) => path.basename(f).startsWith('ours.');
  const lines: string[] = [
    briefHeader('reviewer', input.unitId, input.round),
    `# review ${input.unitId} (round ${input.round})`,
    '',
    '## what to do',
    '',
    `the mechanical verify passed this ${kind} of ${url} at threshold ${input.threshold}: the pixel score, the computed styles and the animations are within the gate. you are the second gate, for what numbers miss. look at the source, ours and the diff with fresh eyes and reject for a concrete difference a person would notice: a wrong or placeholder image, text that differs, an item missing, an interactive state that is not built or behaves differently (a menu, a modal, an accordion), a font that is not the source's. do not edit anything and do not run anything; you have Read, Glob and Grep, and Read shows an image.`,
    '',
    '## look at',
    '',
    ...describeUnit(pack, input.manifest, input.unitId, unit, section),
    '',
    ...shots(pack, unit.unitDir, section, input.manifest.units[input.unitId]?.reachable).map((l) =>
      l.replace(/^- /, '- source, '),
    ),
    ...input.verify.artefacts.filter(isOurs).map((a) => `- ours: ${a}`),
    ...input.verify.artefacts.filter((a) => !isOurs(a)).map((a) => `- verify: ${a}`),
    '',
    'verify said:',
    '',
    '```',
    summarise(input.verify),
    '```',
    '',
    '## how to look',
    '',
    '1. Read the source crop and the ours crop at each viewport listed (the full pages for a page or a state): compare them as pictures, region by region, top to bottom.',
    '2. Read the diff png: red marks the pixels that differ. verify already found the count acceptable; you judge what the red is. anti-aliasing and scattered pixels are nothing; a missing element, a different image or a shifted block is a difference.',
    '3. check the text: every heading, item title, description and button label listed above, exactly, in the same order. check the counts: as many items, links, images and buttons as the source.',
    '4. for a state: the page after the actions must show the same thing (a menu open with the same entries, a modal with the same fields), reached the same way.',
    '5. reject only for a difference you can name and point at (which viewport, which element, what the source has, what ours has). when you find none, pass.',
    '',
    '## the builder said',
    '',
    input.builder
      ? `${input.builder.summary}\n\nfiles: ${input.builder.filesTouched.join(', ') || 'none listed'}\n\nnotes: ${input.builder.notes || 'none'}`
      : 'nothing (its output was not readable)',
    '',
    '## verdict',
    '',
    'answer with one json object and nothing else: `{"verdict": "pass" | "reject", "reasons": ["<one concrete difference each>"]}`; reasons stay empty on a pass, and every reason names what to look at and what is wrong.',
    '',
  ];
  return lines.join('\n');
}
