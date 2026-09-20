import fs from 'node:fs/promises';
import path from 'node:path';
import { VIEWPORT_NAMES } from '../../pack/defaults';
import { parseUnitId, slugify, unitIdForSection } from '../../pack/ids';
import { loadManifest, readJson } from '../../pack/io';
import { PackPaths, UNIT_FILES } from '../../pack/paths';
import {
  AnimationsFileSchema,
  AssetIndexSchema,
  PageMetaSchema,
  SectionsFileSchema,
  type AnimationsFile,
  type PageMeta,
  type Section,
} from '../../pack/schemas';
import {
  CHROME_ROLES,
  componentFileFor,
  componentNameFor,
  featureFor,
  routeFileFor,
} from '../layout';
import {
  EMPTY_DIRS,
  EMPTY_TOKENS,
  eslintConfig,
  GENERATED,
  layoutFile,
  packageJson,
  tailwindConfig,
  type SnapshotPackage,
  type ThemeTokens,
} from './template';
import { VERBATIM } from './snapshot';

/**
 * `rgb(37, 99, 235)` becomes the token `pack-2563eb: #2563eb`; an alpha keeps the rgba as the
 * value and its percent in the name. computed styles only ever say rgb or rgba, so a gradient,
 * a keyword or a fully transparent colour has no token.
 */
export function colourToken(colour: string): { name: string; value: string } | null {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(colour.trim());
  if (!m) return null;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const hex = [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
  const alpha = m[4] === undefined ? 1 : Number(m[4]);
  if (alpha <= 0) return null;
  if (alpha >= 1) return { name: `pack-${hex}`, value: `#${hex}` };
  return {
    name: `pack-${hex}-${Math.round(alpha * 100)}`,
    value: `rgba(${r}, ${g}, ${b}, ${alpha})`,
  };
}

/** jsx text: what react/no-unescaped-entities and the parser would trip on */
function jsxText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tagFor(role: string): string {
  return CHROME_ROLES.has(role) ? role : 'section';
}

/**
 * the printWidth of the snapshot's .prettierrc, which the scaffold copies verbatim. the
 * generated text is written the way that prettier would print it, so a rebuild lints clean
 * before anything formats it (a long section id or heading is what forces a break).
 */
const PRINT_WIDTH = 80;

/**
 * an opening tag, its attributes on lines of their own when prettier would have to break them.
 * only for a tag with two attributes or more: prettier never breaks the attributes of an
 * element that has a single string attribute, however long the line comes out.
 */
function tagLines(indent: number, tag: string, attrs: string[], close: '>' | '/>'): string[] {
  const pad = ' '.repeat(indent);
  const open = `${pad}<${tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}${close === '/>' ? ' ' : ''}${close}`;
  if (open.length <= PRINT_WIDTH) return [open];
  return [`${pad}<${tag}`, ...attrs.map((a) => `${pad}  ${a}`), `${pad}${close}`];
}

/** jsx text the way prettier fills it: greedily, breaking only where there is a space */
function textLines(indent: number, text: string): string[] {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (!line) line = word;
    else if (indent + line.length + 1 + word.length <= PRINT_WIDTH) line += ` ${word}`;
    else {
      lines.push(pad + line);
      line = word;
    }
  }
  if (line) lines.push(pad + line);
  return lines;
}

/**
 * the `return` of a component whose jsx prettier is free to keep on one line: the whole
 * statement inline, then the element alone inside parentheses, then the broken element. an
 * element prettier must break anyway (two attributes or more, or a jsx element child) never
 * reaches the first two rungs, so those components pass their own broken lines and start there.
 */
function returnLines(col: number, element: string, broken: string[]): string[] {
  const pad = ' '.repeat(col);
  const inline = `${pad}return ${element};`;
  if (inline.length <= PRINT_WIDTH) return [inline];
  if (col + 2 + element.length <= PRINT_WIDTH) {
    return [`${pad}return (`, `${' '.repeat(col + 2)}${element}`, `${pad});`];
  }
  return [`${pad}return (`, ...broken, `${pad});`];
}

/**
 * `export const <name> = () => {`, and the two columns the body loses when prettier has to
 * break that line after the `=`. every width decision below is made at the real column, so a
 * component whose name is long is written the way prettier would print it too.
 */
function componentLines(name: string, body: (col: number) => string[]): string[] {
  const one = `export const ${name} = () => {`;
  if (one.length <= PRINT_WIDTH) return [one, ...body(2), '};'];
  return [`export const ${name} =`, '  () => {', ...body(4), '  };'];
}

/** `<h1>text</h1>`, broken onto its own lines when prettier would have to break it */
function headingLines(indent: number, tag: string, text: string): string[] {
  const one = `${' '.repeat(indent)}<${tag}>${text}</${tag}>`;
  if (one.length <= PRINT_WIDTH) return [one];
  return [
    `${' '.repeat(indent)}<${tag}>`,
    ...textLines(indent + 2, text),
    `${' '.repeat(indent)}</${tag}>`,
  ];
}

/** the stub a worker starts from: the landmark tag, the data-section, the heading, 80px so the extractor lists it */
export function sectionStub(section: Section): string {
  const tag = tagFor(section.role);
  const h = section.role === 'hero' ? 'h1' : 'h2';
  // two attributes, and a heading is a jsx element child: prettier always breaks this one
  const lines = componentLines(componentNameFor(section.id), (col) => [
    `${' '.repeat(col)}return (`,
    ...tagLines(col + 2, tag, [`data-section="${section.id}"`, 'className="min-h-20"'], '>'),
    ...(section.heading
      ? headingLines(col + 4, h, jsxText(section.heading))
      : [`${' '.repeat(col + 4)}{/* ${section.role} */}`]),
    `${' '.repeat(col + 2)}</${tag}>`,
    `${' '.repeat(col)});`,
  ]);
  return `${lines.join('\n')}\n`;
}

/** the shared chrome itself: one component per role under layouts, given the page's section id */
export function chromeStub(role: string): string {
  const name = `Site${componentNameFor(role)}`;
  const body = [
    ...tagLines(4, role, ['data-section={sectionId}', 'className="min-h-20"'], '>'),
    `      {/* ${role}, shared by every page */}`,
    `    </${role}>`,
  ];
  return `type ${name}Props = { sectionId: string };

export const ${name} = ({ sectionId }: ${name}Props) => {
  return (
${body.join('\n')}
  );
};
`;
}

/**
 * a section whose chrome is shared still gets the file the mapping names, so the worker for
 * `page:index#s01-header` has somewhere to work and the route imports every section the same
 * way; the shared markup itself lives in the layout, rendered with this page's section id.
 */
export function chromeSectionStub(section: Section): string {
  const layout = `Site${componentNameFor(section.role)}`;
  // prettier never breaks the attributes of an element that has one string attribute, however
  // long the line comes out, so the last rung is that same line
  const element = `<${layout} sectionId="${section.id}" />`;
  const lines = componentLines(componentNameFor(section.id), (col) =>
    returnLines(col, element, [`${' '.repeat(col + 2)}${element}`]),
  );
  return `import { ${layout} } from '@/components/layouts/site-${section.role}';

${lines.join('\n')}
`;
}

// claude: milestone 5 decides what a flow step's component is once the builder brief for a
// step exists; until then the stub only reserves the file the mapping names
export function stepStub(flow: string, step: string, n: number): string {
  const comment = `{/* flow ${flow}, step ${n} */}`;
  // one attribute and one comment child, so prettier is free to keep this on one line
  const element = `<section className="min-h-20">${comment}</section>`;
  const lines = componentLines(componentNameFor(step), (col) =>
    returnLines(col, element, [
      `${' '.repeat(col + 2)}<section className="min-h-20">`,
      `${' '.repeat(col + 4)}${comment}`,
      `${' '.repeat(col + 2)}</section>`,
    ]),
  );
  return `${lines.join('\n')}\n`;
}

export interface RouteInput {
  feature: string;
  sections: Section[];
}

/**
 * the route composes only: chrome outside main, the sections inside, in the pack's order.
 * every section comes from the feature, shared chrome included, so the route never has to
 * know which roles are shared; the wrapper stub is what reaches into the layout.
 */
export function routeFile(input: RouteInput): string {
  // by component name: one import line per component however often the page renders it
  const imports = new Map<string, string>();
  const render = (s: Section): string => {
    const name = componentNameFor(s.id);
    imports.set(name, `@/features/${input.feature}/components/${s.id}`);
    return `<${name} />`;
  };
  const inMain = input.sections.filter((s) => !CHROME_ROLES.has(s.role));
  const chrome = input.sections.filter((s) => CHROME_ROLES.has(s.role));
  const firstMain = inMain[0]?.order;
  // a chrome-only page has no order to split on, and a footer is the chrome that goes below
  const isBefore = (s: Section) =>
    firstMain === undefined ? s.role !== 'footer' : s.order < firstMain;
  const main = inMain.length
    ? ['<main>', ...inMain.map((s) => `  ${render(s)}`), '</main>']
    : ['<main />'];
  const body = [
    ...chrome.filter(isBefore).map((s) => render(s)),
    ...main,
    ...chrome.filter((s) => !isBefore(s)).map((s) => render(s)),
  ];
  const lines = [...imports]
    .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, from]) => `import { ${name} } from '${from}';`);
  return `${lines.length ? `${lines.join('\n')}\n\n` : ''}const Page = () => {
  return (
    <>
${body.map((l) => `      ${l}`).join('\n')}
    </>
  );
};

export default Page;
`;
}

function sortedRecord<T>(r: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * one css value list, split on its top-level commas only: `animation-timing-function` reads
 * `cubic-bezier(0.4, 0, 0.2, 1), linear` for two animations, and a plain split would make
 * five values out of it and write a broken shorthand into the theme.
 */
function splitList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out;
}

/** the theme from the pack: colours, font families, keyframes by their source names, the animation shorthand per name */
export function tokensFrom(metas: PageMeta[], animations: AnimationsFile[]): ThemeTokens {
  const tokens: ThemeTokens = { colors: {}, fontFamily: {}, keyframes: {}, animation: {} };
  for (const meta of metas) {
    for (const c of meta.colours) {
      const t = colourToken(c);
      if (t) tokens.colors[t.name] = t.value;
    }
    for (const f of meta.fonts) {
      const key = slugify(f.family) || 'sans';
      if (!tokens.fontFamily[key]) tokens.fontFamily[key] = [f.family];
    }
  }
  for (const a of animations) {
    for (const [name, kf] of Object.entries(a.keyframes)) {
      if (tokens.keyframes[name]) continue;
      tokens.keyframes[name] = Object.fromEntries(kf.stops.map((s) => [s.offset, s.declarations]));
    }
    for (const vp of VIEWPORT_NAMES) {
      for (const el of Object.values(a.elements[vp])) {
        const anim = el.animation;
        if (!anim) continue;
        const names = splitList(anim['animation-name'] ?? '');
        names.forEach((name, i) => {
          if (!name || name === 'none' || tokens.animation[name]) return;
          const part = (prop: string) => splitList(anim[prop] ?? '')[i] ?? '';
          tokens.animation[name] = [
            name,
            part('animation-duration'),
            part('animation-timing-function'),
            part('animation-delay'),
            part('animation-iteration-count'),
            part('animation-direction'),
            part('animation-fill-mode'),
          ]
            .filter(Boolean)
            .join(' ');
        });
      }
    }
  }
  return {
    colors: sortedRecord(tokens.colors),
    fontFamily: sortedRecord(tokens.fontFamily),
    keyframes: sortedRecord(tokens.keyframes),
    animation: sortedRecord(tokens.animation),
  };
}

export interface FontFile {
  family: string;
  weight: string;
  style: string;
  /** the file name under src/assets/fonts */
  file: string;
}

const FORMATS: Record<string, string> = {
  woff2: 'woff2',
  woff: 'woff',
  ttf: 'truetype',
  otf: 'opentype',
};

/**
 * @font-face rules under the source's own family names. not next/font/local: it renames the
 * family to a hashed one, and the style gate compares font-family by name (spec section 6).
 */
export function fontsCss(fonts: FontFile[]): string {
  const rules = fonts.map((f) => {
    const format = FORMATS[path.extname(f.file).slice(1).toLowerCase()];
    return `@font-face {
  font-family: '${f.family.replace(/'/g, "\\'")}';
  src: url('../assets/fonts/${f.file}')${format ? ` format('${format}')` : ''};
  font-weight: ${f.weight};
  font-style: ${f.style};
}`;
  });
  return `/* generated from the pack: the source's font files under their own family names */\n${rules.join('\n\n')}\n`;
}

/** what fonts.css says when the pack captured no font file at all */
export const NO_FONTS_CSS = '/* generated from the pack: no font files were captured */\n';

export function fontsCssFor(fonts: FontFile[]): string {
  return fonts.length ? fontsCss(fonts) : NO_FONTS_CSS;
}

/** one page's captured fonts into the shared map, keyed so a face is declared once however many pages load it */
function collectFonts(
  meta: PageMeta,
  assetsDir: string,
  into: Map<string, { font: FontFile; from: string }>,
): void {
  for (const f of meta.fonts) {
    if (!f.file) continue;
    const key = `${f.family}|${f.weight}|${f.style}|${f.file}`;
    if (!into.has(key)) {
      into.set(key, {
        font: { family: f.family, weight: f.weight, style: f.style, file: f.file },
        from: path.join(assetsDir, f.file),
      });
    }
  }
}

export interface PackTheme {
  tokens: ThemeTokens;
  fonts: FontFile[];
}

/**
 * the theme and the font faces a pack generates, read again without writing anything: what
 * generateFromPack put into tailwind.config.cjs and src/styles/fonts.css, from the same pages
 * (every page unit with a url and its three unit files on disk), in the same order (by
 * feature), so a keyframe two pages name differently resolves the same way. the brand phase
 * layers brand.json over this and writes the two files afresh.
 */
export async function packTheme(root: string): Promise<PackTheme> {
  const manifest = await loadManifest(root);
  const pack = new PackPaths(root);
  const pages: { id: string; feature: string; dir: string }[] = [];
  for (const [id, unit] of Object.entries(manifest.units)) {
    if (unit.kind !== 'page' || !unit.url) continue;
    const dir = pack.unitDir(id);
    let complete = true;
    for (const f of [UNIT_FILES.sections, UNIT_FILES.meta, UNIT_FILES.animations]) {
      if (!(await exists(path.join(dir, f)))) complete = false;
    }
    if (complete) pages.push({ id, feature: featureFor(id), dir });
  }
  pages.sort((a, b) => (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));
  const metas: PageMeta[] = [];
  const animations: AnimationsFile[] = [];
  const fontFiles = new Map<string, { font: FontFile; from: string }>();
  for (const page of pages) {
    const meta = await readJson(PageMetaSchema, path.join(page.dir, UNIT_FILES.meta));
    metas.push(meta);
    animations.push(
      await readJson(AnimationsFileSchema, path.join(page.dir, UNIT_FILES.animations)),
    );
    collectFonts(meta, pack.assetsDir(page.dir), fontFiles);
  }
  return {
    tokens: tokensFrom(metas, animations),
    // the order the pages yielded them, which is the order generateFromPack writes the rules
    // in: a brand with no font override then leaves fonts.css byte for byte as it was
    fonts: [...fontFiles.values()].map(({ font }) => font),
  };
}

/**
 * the blank scaffold: the verbatim files copied, package.json filtered to the kept
 * dependencies at the snapshot's versions, the generated files written, the empty dirs of
 * the shape kept with a .gitkeep. the demo features, the mock server, storybook, the e2e
 * tests and the generators never come across. generateFromPack writes over this.
 */
export async function pruneSnapshot(
  source: string,
  dest: string,
  opts: { name: string },
): Promise<void> {
  const write = async (rel: string, content: string | Buffer) => {
    const to = path.join(dest, rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFile(to, content);
  };
  for (const rel of VERBATIM) await write(rel, await fs.readFile(path.join(source, rel)));
  const snapshot = JSON.parse(
    await fs.readFile(path.join(source, 'package.json'), 'utf8'),
  ) as SnapshotPackage;
  await write('package.json', packageJson(snapshot, opts.name));
  await write('.eslintrc.cjs', eslintConfig([]));
  await write('tailwind.config.cjs', tailwindConfig(EMPTY_TOKENS));
  await write('src/app/layout.tsx', layoutFile(opts.name));
  for (const [rel, text] of Object.entries(GENERATED)) await write(rel, text);
  for (const dir of EMPTY_DIRS) await write(path.join(dir, '.gitkeep'), '');
}

export interface Generated {
  features: string[];
  components: string[];
  routes: string[];
  layouts: string[];
  fonts: string[];
  assets: string[];
  tokens: ThemeTokens;
}

// claude: one of six copies of this exists() helper (snapshot.ts, scaffold.ts, here,
// cli/commands/scaffold.ts, src/verify/verify.ts, test/helpers/scaffold-cache.ts); a shared fs
// util is a later task
async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * the blank rebuild from a pack (spec section 7): one feature per captured page with one stub
 * per section, one route per page composing them in order, header, nav and footer shared as
 * layouts when more than one page has them, one feature per flow with one stub per step, the
 * theme from the pack's colours, fonts and keyframes, the font files and the images under
 * src/assets. every path returned is relative to the project.
 */
export async function generateFromPack(opts: {
  root: string;
  project: string;
}): Promise<Generated> {
  const manifest = await loadManifest(opts.root);
  const pack = new PackPaths(opts.root);
  const out: Generated = {
    features: [],
    components: [],
    routes: [],
    layouts: [],
    fonts: [],
    assets: [],
    tokens: { colors: {}, fontFamily: {}, keyframes: {}, animation: {} },
  };
  const write = async (rel: string, text: string) => {
    const file = path.join(opts.project, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  };
  const copy = async (from: string, rel: string) => {
    const file = path.join(opts.project, rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.copyFile(from, file);
  };

  // every path below comes from layout.ts: the worker that rebuilds a unit is pointed at the
  // same file this writes the stub into, and one module owns that mapping
  const pages: { id: string; feature: string; dir: string; sections: Section[] }[] = [];
  for (const [id, unit] of Object.entries(manifest.units)) {
    // a page with no url has no route
    if (unit.kind !== 'page' || !unit.url) continue;
    const dir = pack.unitDir(id);
    // a blocked or half-captured page has some of its unit files and not others; reading one
    // that is not there would throw ENOENT halfway and take the whole out dir with it
    const missing: string[] = [];
    for (const f of [UNIT_FILES.sections, UNIT_FILES.meta, UNIT_FILES.animations]) {
      if (!(await exists(path.join(dir, f)))) missing.push(f);
    }
    if (missing.length) {
      console.warn(`${id}: ${dir} has no ${missing.join(', ')}; the page is not generated`);
      continue;
    }
    pages.push({
      id,
      feature: featureFor(id),
      dir,
      sections: await readJson(SectionsFileSchema, path.join(dir, UNIT_FILES.sections)),
    });
  }
  // the same three-way comparator packTheme uses: two pages of one feature must come out in
  // the same order on both sides, or the theme read back could resolve a keyframe differently
  pages.sort((a, b) => (a.feature < b.feature ? -1 : a.feature > b.feature ? 1 : 0));

  const roleCount = new Map<string, number>();
  for (const page of pages) {
    for (const role of new Set(page.sections.map((s) => s.role))) {
      if (CHROME_ROLES.has(role)) roleCount.set(role, (roleCount.get(role) ?? 0) + 1);
    }
  }
  const shared = new Set([...roleCount].filter(([, n]) => n >= 2).map(([role]) => role));
  for (const role of [...shared].sort()) {
    const rel = `src/components/layouts/site-${role}.tsx`;
    await write(rel, chromeStub(role));
    out.layouts.push(rel);
  }

  const metas: PageMeta[] = [];
  const animations: AnimationsFile[] = [];
  const fontFiles = new Map<string, { font: FontFile; from: string }>();
  const assetFiles = new Map<string, string>();
  // a feature is a dir with something in it: one that never got a file must not reach the
  // eslint zones, where it would restrict imports from a path that does not exist
  const features = new Set<string>();
  for (const page of pages) {
    for (const s of page.sections) {
      const rel = componentFileFor(manifest, unitIdForSection(page.id, s.id));
      const wraps = CHROME_ROLES.has(s.role) && shared.has(s.role);
      await write(rel, wraps ? chromeSectionStub(s) : sectionStub(s));
      out.components.push(rel);
      features.add(page.feature);
    }
    const route = routeFileFor(manifest, page.id);
    await write(route, routeFile({ feature: page.feature, sections: page.sections }));
    out.routes.push(route);
    const meta = await readJson(PageMetaSchema, path.join(page.dir, UNIT_FILES.meta));
    metas.push(meta);
    animations.push(
      await readJson(AnimationsFileSchema, path.join(page.dir, UNIT_FILES.animations)),
    );
    collectFonts(meta, pack.assetsDir(page.dir), fontFiles);
  }
  for (const id of Object.keys(manifest.units)) {
    const dir = pack.unitDir(id);
    const index = path.join(dir, UNIT_FILES.assetsIndex);
    if (!(await exists(index))) continue;
    for (const entry of await readJson(AssetIndexSchema, index)) {
      if ((entry.kind === 'image' || entry.kind === 'svg') && !assetFiles.has(entry.file)) {
        assetFiles.set(entry.file, path.join(pack.assetsDir(dir), entry.file));
      }
    }
  }

  for (const flow of Object.values(manifest.flows)) {
    for (const [i, id] of flow.steps.entries()) {
      const p = parseUnitId(id);
      if (p.kind !== 'flowStep') continue;
      // the flow's own name, from the step's id: the zone and the path say the same thing
      const feature = featureFor(id);
      const rel = componentFileFor(manifest, id);
      await write(rel, stepStub(feature, p.step, i + 1));
      out.components.push(rel);
      features.add(feature);
    }
  }

  // the pack's own face order, the one fonts.css below and packTheme both keep
  for (const { font, from } of fontFiles.values()) {
    const rel = `src/assets/fonts/${font.file}`;
    await copy(from, rel);
    out.fonts.push(rel);
  }
  await write('src/styles/fonts.css', fontsCssFor([...fontFiles.values()].map((f) => f.font)));
  for (const [file, from] of [...assetFiles].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const rel = `src/assets/${file}`;
    await copy(from, rel);
    out.assets.push(rel);
  }
  out.tokens = tokensFrom(metas, animations);
  await write('tailwind.config.cjs', tailwindConfig(out.tokens));
  out.features = [...features].sort();
  await write('.eslintrc.cjs', eslintConfig(out.features));
  out.components.sort();
  out.routes.sort();
  return out;
}
