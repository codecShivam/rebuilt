import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { openSession, type Session } from '../capture/session';
import { slugify } from '../pack/ids';
import { loadManifest, readJson, writeFileAtomic } from '../pack/io';
import { RunPaths } from '../pack/paths';
import { BrandSchema, type Brand, type Manifest } from '../pack/schemas';
import { gateStructure, substitute, type GateResult } from '../verify/brand';
import { freeRunName, killStaleDevServers, runName } from './build';
import { startDevServer, type DevServer } from './scaffold/dev-server';
import { fontsCssFor, packTheme, type FontFile } from './scaffold/generate';
import { tailwindConfig, type ThemeTokens } from './scaffold/template';

export interface LoadedBrand {
  brand: Brand;
  /** absolute */
  file: string;
  /** what every file the brand names is relative to */
  dir: string;
}

/** brand.json read and validated (path and field on failure), every file it names checked to exist under its own dir */
export async function loadBrand(file: string): Promise<LoadedBrand> {
  const abs = path.resolve(file);
  const brand = await readJson(BrandSchema, abs);
  const dir = path.dirname(abs);
  const named = [
    ...Object.entries(brand.logos).map(([k, v]) => ({ field: `logos.${k}`, file: v })),
    ...Object.entries(brand.fonts).flatMap(([k, f]) =>
      f.faces.map((face, i) => ({ field: `fonts.${k}.faces.${i}.file`, file: face.file })),
    ),
  ];
  for (const n of named) {
    const at = path.resolve(dir, n.file);
    // under its own dir is what the message claims and what a brand is: a `../` or an absolute
    // path reaches out of the folder the brand was handed, and the copy would carry a file
    // nobody sent into the project
    const under = at.startsWith(dir + path.sep);
    if (
      !under ||
      !(await fs.access(at).then(
        () => true,
        () => false,
      ))
    ) {
      throw new Error(`${abs}: ${n.field} names ${n.file}, which is not under ${dir}`);
    }
  }
  return { brand, file: abs, dir };
}

/**
 * brand.json layered over the pack's theme. an overridden colour token keeps its name and
 * takes the brand value, so `bg-pack-2563eb` in a component now paints the brand's colour
 * without the component changing; an overridden family keeps its token key (`font-fixture`)
 * and takes the brand family as its value. a token or a family the pack never had is refused
 * with the list of what it has: a silent no-op here would be a brand that never lands.
 */
export function applyBrandTokens(tokens: ThemeTokens, brand: Brand): ThemeTokens {
  const colors = { ...tokens.colors };
  for (const [token, value] of Object.entries(brand.colors)) {
    if (!(token in colors)) {
      throw new Error(
        `brand.json colors: the theme has no token ${token}; it has ${Object.keys(colors).join(', ') || 'none'}`,
      );
    }
    colors[token] = value;
  }
  const fontFamily = { ...tokens.fontFamily };
  for (const [source, font] of Object.entries(brand.fonts)) {
    const key = slugify(source) || 'sans';
    if (!(key in fontFamily)) {
      throw new Error(
        `brand.json fonts: the theme has no family ${source}; it has ${
          Object.values(fontFamily)
            .map((v) => v.join(', '))
            .join('; ') || 'none'
        }`,
      );
    }
    fontFamily[key] = [font.family];
  }
  return { ...tokens, colors, fontFamily };
}

/**
 * the face list for src/styles/fonts.css with the brand's faces in place of the source's:
 * every face of an overridden family goes (its file listed for removal) and the brand's faces
 * come in under the brand family, their files by basename. a family with no captured faces
 * (a system font the pack saw by name) is overridden the same way, with nothing to remove.
 * the faces the brand leaves alone keep the pack's own order, the order the scaffold wrote
 * them in, so a brand with no font override changes not a byte of fonts.css; the brand's own
 * faces follow, in the order brand.json names them.
 */
export function brandFontFaces(
  fonts: FontFile[],
  brand: Brand,
  dir: string,
): { faces: FontFile[]; removed: string[]; copies: { from: string; file: string }[] } {
  const overridden = new Set(Object.keys(brand.fonts));
  const source = [...new Set(fonts.filter((f) => overridden.has(f.family)).map((f) => f.file))];
  const faces = fonts.filter((f) => !overridden.has(f.family));
  const copies: { from: string; file: string }[] = [];
  for (const font of Object.values(brand.fonts)) {
    for (const face of font.faces) {
      const file = path.basename(face.file);
      faces.push({ family: font.family, weight: face.weight, style: face.style, file });
      copies.push({ from: path.resolve(dir, face.file), file });
    }
  }
  // a brand face whose basename is a source face's name replaces that file rather than
  // displacing it: removing it after the copy would delete the face the css now names
  const copied = new Set(copies.map((c) => c.file));
  return { faces, removed: source.filter((f) => !copied.has(f)).sort(), copies };
}

/**
 * an import, export or require specifier: the file it names is not renamed. the span is
 * anchored on the clause rather than on the `import` keyword, because prettier breaks a long
 * import over several lines and a keyword-anchored span would stop at the first newline,
 * leaving the path in the open; `import '<path>'` and `import('<path>')` have no `from` and
 * keep their own alternative. a line of prose that happens to read `... from 'something'` is
 * fenced too, which is the safe direction: a name left standing is reported as a leftover, a
 * rewritten module path breaks tsc and next lint.
 */
const MODULE_SPECIFIER = [
  String.raw`\bfrom\s*['"][^'"\n]*['"]`,
  String.raw`\bimport\s*\(?\s*['"][^'"\n]*['"]\s*\)?`,
  String.raw`\brequire\s*\(\s*['"][^'"\n]*['"]\s*\)`,
].join('|');

/**
 * the attributes that are an id or a path rather than words on the page: every `data-*` as a
 * class (the verifier's keys are two of them, and the spec's ruling is the class), the
 * `sectionId` the wrapper stubs hand the shared chrome (the layout puts it into
 * `data-section`, so a rewritten one breaks the verifier where the gate cannot see it), and
 * the paths and handles a rename would break.
 */
const FENCED_ATTRIBUTE = String.raw`data-[a-z0-9-]+|className|class|href|srcSet|src|poster|formAction|sectionId|id|name|key|htmlFor`;

/**
 * an attribute's value: a quoted string, which may run over several lines because a jsx
 * attribute string cannot carry its own quote (a `srcSet` prettier broke stays fenced), or an
 * expression in braces balancing one level of nesting, so `className={cn({ active },
 * 'fixture-card')}` is fenced whole rather than up to the first inner brace, over lines or not.
 * the three alternatives are exclusive on their first character, so the scan stays linear.
 */
const ATTRIBUTE_VALUE = String.raw`"[^"]*"|'[^']*'|\{(?:[^{}]|\{[^{}]*\})*\}`;

/** how a path begins: a root, a relative step, the `@/` alias, an anchor, or a scheme */
const PATH_START = String.raw`/|\./|\.\./|@/|#|[a-zA-Z][a-zA-Z0-9+.-]*://`;

/**
 * a path-shaped string literal wherever it stands, not only in an attribute: a route in
 * `src/config/paths.ts`, an entry of a links array, a `const`. a backtick literal counts only
 * when it carries no expression (a `$` in it is not a path's). a prose literal is left open:
 * the fence is on how the value begins, not on its being quoted.
 */
const PATH_LITERAL = [
  String.raw`'(?:${PATH_START})[^'\n]*'`,
  String.raw`"(?:${PATH_START})[^"\n]*"`,
  String.raw`\`(?:${PATH_START})[^\`\n$]*\``,
].join('|');

/**
 * spans of a component a name must never land in. everything between them is text and takes
 * the substitution. one capturing group, so String.split hands the spans back at odd indices.
 */
export const PROTECTED_SPANS = new RegExp(
  `(${[
    MODULE_SPECIFIER,
    String.raw`\b(?:${FENCED_ATTRIBUTE})=(?:${ATTRIBUTE_VALUE})`,
    PATH_LITERAL,
  ].join('|')})`,
  'g',
);

/** the names substituted over one source file, its protected spans left as they are */
export function substituteInSource(
  text: string,
  names: Record<string, string>,
): { text: string; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const parts = text.split(PROTECTED_SPANS);
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part;
    const r = substitute(part, names);
    for (const [k, n] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + n;
    return r.text;
  });
  return { text: out.join(''), counts };
}

/**
 * the file under src/assets/ a logo key names: the file itself, or the one file whose name
 * ends in `-<key>` (the asset store names a capture `<kind>-<hash>-<basename>`, and the hash
 * is of the source url, so a brand names the basename and the store's own name both work).
 */
export async function resolveAsset(project: string, key: string): Promise<string> {
  const dir = path.join(project, 'src', 'assets');
  let names: string[];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name);
  } catch (err) {
    // no assets dir at all is "nothing matches"; a permission or an io error is not, and
    // reading it as one would blame the brand for a project that cannot be read
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw new Error(`brand.json logos: cannot read ${dir}: ${e.message}`);
    names = [];
  }
  if (names.includes(key)) return path.join(dir, key);
  const matches = names.filter((n) => n.endsWith(`-${key}`));
  if (matches.length === 1) return path.join(dir, matches[0]!);
  throw new Error(
    matches.length
      ? `brand.json logos: ${key} names ${matches.length} files under src/assets: ${matches.join(', ')}`
      : `brand.json logos: nothing under src/assets is ${key} or ends in -${key}`,
  );
}

export interface LogoChange {
  /** project-relative file, and the brand file that went into it */
  replaced: { file: string; from: string }[];
  /** already the brand's bytes: a second run */
  unchanged: { file: string; from: string }[];
}

/** every logo copied over the asset it names, in place and under the asset's own name, so every reference to it stands */
export async function replaceLogos(project: string, loaded: LoadedBrand): Promise<LogoChange> {
  const replaced: LogoChange['replaced'] = [];
  const unchanged: LogoChange['unchanged'] = [];
  for (const [key, rel] of Object.entries(loaded.brand.logos)) {
    const target = await resolveAsset(project, key);
    const from = path.resolve(loaded.dir, rel);
    if (path.extname(target).toLowerCase() !== path.extname(from).toLowerCase()) {
      throw new Error(
        `brand.json logos: ${key} is ${path.extname(target)} and ${rel} is ${path.extname(from)}; a logo keeps its format, because the components reference it by name`,
      );
    }
    const bytes = await fs.readFile(from);
    const file = path.relative(project, target).split(path.sep).join('/');
    if ((await fs.readFile(target)).equals(bytes)) unchanged.push({ file, from: rel });
    else {
      await writeFileAtomic(target, bytes);
      replaced.push({ file, from: rel });
    }
  }
  return { replaced, unchanged };
}

/**
 * a regular file, which a symlink is not: the walker below and the snapshot further down read
 * a tree for two halves of the same job, and a symlinked component the codemod rewrote but the
 * snapshot never hashed would land outside the change list and never reach prettier.
 */
function isRegularFile(entry: import('node:fs').Dirent): boolean {
  return entry.isFile();
}

/** every file under src/ whose name matches, sorted: the components, the routes, the layouts and the config alike */
async function filesUnderSrc(project: string, pattern: RegExp): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (isRegularFile(e) && pattern.test(e.name)) out.push(p);
    }
  };
  await walk(path.join(project, 'src'));
  return out.sort();
}

export interface NamesChange {
  /** every key of the table, with how often it was replaced; zero for a key never met */
  counts: Record<string, number>;
  /** project-relative file to how many replacements landed in it; a file with none is not listed and not written */
  files: Record<string, number>;
}

/** the names substituted over the project's source, a file written only when a name landed in it */
export async function applyNames(
  project: string,
  names: Record<string, string>,
): Promise<NamesChange> {
  const counts: Record<string, number> = {};
  const files: Record<string, number> = {};
  for (const key of Object.keys(names)) counts[key] = 0;
  if (!Object.keys(names).length) return { counts, files };
  for (const file of await filesUnderSrc(project, /\.tsx?$/)) {
    const before = await fs.readFile(file, 'utf8');
    const r = substituteInSource(before, names);
    const n = Object.values(r.counts).reduce((a, b) => a + b, 0);
    if (!n) continue;
    await writeFileAtomic(file, r.text);
    files[path.relative(project, file).split(path.sep).join('/')] = n;
    for (const [k, c] of Object.entries(r.counts)) counts[k] = (counts[k] ?? 0) + c;
  }
  return { counts, files };
}

export interface ThemeChange {
  colors: { token: string; from: string; to: string }[];
  fonts: { source: string; family: string; faces: FontFile[] }[];
  /** project-relative face files written (not listed when the bytes were there already) */
  copied: string[];
  /** project-relative source face files removed (not listed when already gone) */
  removed: string[];
}

/**
 * the theme and the faces regenerated from the pack with the brand layered over them: the
 * theme is read-only for every worker (milestone 5), so what the scaffold generated is what is
 * there, and regenerating it is the codemod. tailwind.config.cjs and src/styles/fonts.css are
 * written whole; the caller formats them and decides by bytes whether anything changed.
 */
export async function writeTheme(
  project: string,
  root: string,
  loaded: LoadedBrand,
): Promise<ThemeChange> {
  const { brand, dir } = loaded;
  const theme = await packTheme(root);
  const tokens = applyBrandTokens(theme.tokens, brand);
  const { faces, removed, copies } = brandFontFaces(theme.fonts, brand, dir);
  await fs.writeFile(path.join(project, 'tailwind.config.cjs'), tailwindConfig(tokens));
  await fs.mkdir(path.join(project, 'src', 'styles'), { recursive: true });
  await fs.writeFile(path.join(project, 'src', 'styles', 'fonts.css'), fontsCssFor(faces));
  const fontsDir = path.join(project, 'src', 'assets', 'fonts');
  await fs.mkdir(fontsDir, { recursive: true });
  const copied: string[] = [];
  for (const c of copies) {
    const to = path.join(fontsDir, c.file);
    const bytes = await fs.readFile(c.from);
    const same = await fs.readFile(to).then(
      (b) => b.equals(bytes),
      () => false,
    );
    if (!same) {
      await fs.writeFile(to, bytes);
      copied.push(`src/assets/fonts/${c.file}`);
    }
  }
  const gone: string[] = [];
  for (const file of removed) {
    const at = path.join(fontsDir, file);
    const there = await fs.stat(at).then(
      () => true,
      () => false,
    );
    if (there) {
      await fs.rm(at);
      gone.push(`src/assets/fonts/${file}`);
    }
  }
  return {
    colors: Object.entries(brand.colors).map(([token, to]) => ({
      token,
      from: theme.tokens.colors[token]!,
      to,
    })),
    fonts: Object.entries(brand.fonts).map(([source, f]) => ({
      source,
      family: f.family,
      faces: faces.filter((x) => x.family === f.family),
    })),
    copied,
    removed: gone,
  };
}

export const DEVIATIONS_FILE = 'deviations.md';

/** sha256 of every file under src/ and of tailwind.config.cjs, by project-relative posix path: everything the codemod may touch */
export async function snapshotTree(project: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const add = async (abs: string) => {
    const rel = path.relative(project, abs).split(path.sep).join('/');
    out.set(
      rel,
      createHash('sha256')
        .update(await fs.readFile(abs))
        .digest('hex'),
    );
  };
  const walk = async (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (isRegularFile(e)) await add(p);
    }
  };
  await walk(path.join(project, 'src'));
  const config = path.join(project, 'tailwind.config.cjs');
  const there = await fs.stat(config).then(
    () => true,
    () => false,
  );
  if (there) await add(config);
  return out;
}

/** the paths whose bytes differ between two snapshots, the added and the removed included, sorted */
export function diffTrees(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [k, v] of after) if (before.get(k) !== v) changed.add(k);
  for (const k of before.keys()) if (!after.has(k)) changed.add(k);
  return [...changed].sort();
}

export interface Leftover {
  family: string;
  /** project-relative */
  file: string;
  line: number;
}

/**
 * every quoted mention of an overridden source family still in the source and the styles: a
 * `font-['Fixture']` a builder wrote, or a plain css file naming the family, which the theme
 * codemod cannot reach. logged for a hand, never rewritten: a family name inside a class is
 * one word of a tailwind value, and the value's spelling is the builder's.
 */
export async function familyLeftovers(project: string, brand: Brand): Promise<Leftover[]> {
  const families = Object.keys(brand.fonts);
  if (!families.length) return [];
  const out: Leftover[] = [];
  for (const file of await filesUnderSrc(project, /\.(tsx?|css)$/)) {
    const rel = path.relative(project, file).split(path.sep).join('/');
    const lines = (await fs.readFile(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const family of families) {
        const quoted = [`'${family}'`, `"${family}"`, `\`${family}\``];
        if (quoted.some((q) => line.includes(q))) out.push({ family, file: rel, line: i + 1 });
      }
    });
  }
  return out;
}

/** the project's own prettier over the text files the codemod wrote, so `next lint`'s prettier rule stays clean and a shorter name never leaves a line prettier would have joined */
async function formatFiles(
  project: string,
  files: string[],
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const text: string[] = [];
  for (const f of files) {
    if (!/\.(tsx?|css|cjs|js|json|md)$/.test(f)) continue;
    // the change list holds what was removed as well as what was written, and prettier exits
    // non-zero on a path that is not there: a removal would fail the run after the codemod landed
    const there = await fs.stat(path.join(project, f)).then(
      (s) => s.isFile(),
      () => false,
    );
    if (there) text.push(f);
  }
  if (!text.length) return;
  await execa('npx', ['prettier', '--write', '--log-level', 'warn', ...text], {
    cwd: project,
    env,
    extendEnv: true,
  });
}

export interface DeviationsInput {
  brandFile: string;
  project: string;
  root: string;
  at: string;
  run: string;
  manifest: Manifest;
  brand: Brand;
  changed: string[];
  theme: ThemeChange;
  logos: LogoChange;
  names: NamesChange;
  leftovers: Leftover[];
  /** null when the run never finished; `error` then says why */
  gate: GateResult | null;
  /** a step threw: what had landed is above, nothing was compared, and the verdict is `error` */
  error?: string;
  /** which step threw, named the way the run logs it; the gate when not given */
  step?: string;
}

/**
 * deviations.md (spec section 7): what the brand phase changed on purpose, what it could not
 * reach, and what the structure gate found under brand normalisation. the phase one line is
 * read from the manifest as it is: the brand phase does not refuse a project whose phase one is
 * not complete, it says so here, because the gate below is what decides.
 */
export function deviationsText(i: DeviationsInput): string {
  const units = Object.values(i.manifest.units);
  const passed = units.filter((u) => u.status === 'passed').length;
  const blocked = units.filter((u) => u.status === 'blocked').length;
  const lines = [
    `# brand: ${i.brandFile}`,
    '',
    `- project: ${i.project}`,
    `- pack: ${i.root}`,
    `- applied: ${i.at}`,
    `- run: runs/${i.run}`,
    `- phase one: ${passed} of ${units.length} units passed, ${blocked} blocked`,
    `- files changed: ${i.changed.length}`,
    ...i.changed.map((f) => `  - ${f}`),
    '',
    '## theme',
    '',
  ];
  for (const c of i.theme.colors) lines.push(`- colour ${c.token}: ${c.from} -> ${c.to}`);
  for (const f of i.theme.fonts) {
    lines.push(
      `- family ${f.source} -> ${f.family}: faces ${f.faces
        .map((x) => `${x.file} (${x.weight} ${x.style})`)
        .join(', ')}`,
    );
  }
  if (i.theme.removed.length) lines.push(`- removed ${i.theme.removed.join(', ')}`);
  if (!i.theme.colors.length && !i.theme.fonts.length) lines.push('- nothing overridden');
  lines.push('', '## logos', '');
  for (const l of i.logos.replaced) lines.push(`- ${l.file} <- ${l.from}`);
  for (const l of i.logos.unchanged) lines.push(`- ${l.file}: already ${l.from}`);
  if (!i.logos.replaced.length && !i.logos.unchanged.length) lines.push('- none');
  lines.push('', '## names', '');
  for (const [k, n] of Object.entries(i.names.counts))
    lines.push(`- ${k} -> ${i.brand.names[k]}: ${n}`);
  for (const [f, n] of Object.entries(i.names.files)) lines.push(`  - ${f}: ${n}`);
  if (!Object.keys(i.names.counts).length) lines.push('- none');
  lines.push('', '## left for you', '');
  for (const l of i.leftovers)
    lines.push(`- ${l.file}:${l.line} still names the family ${l.family}`);
  if (!i.leftovers.length) lines.push('- nothing');
  lines.push('', '## structure gate (brand normalisation on)', '');
  if (i.error) {
    lines.push(
      `- the ${i.step ?? 'gate'} did not finish: ${i.error}`,
      `- its run dir is runs/${i.run}`,
    );
  }
  for (const u of i.gate?.units ?? []) {
    lines.push(`- ${u.unitId}: ${u.findings.length ? 'fail' : 'pass'}`);
    for (const f of u.findings)
      lines.push(`  - ${f.kind} @ ${f.where}: expected ${f.expected}, got ${f.actual}`);
  }
  for (const s of i.gate?.skipped ?? []) lines.push(`- ${s.unitId}: skipped, ${s.reason}`);
  lines.push('', `verdict: ${i.error || !i.gate ? 'error' : i.gate.verdict}`, '');
  return lines.join('\n');
}

/** what a rebuild has and a mistyped --project has not: the two files the codemod rewrites and the two dirs it walks */
const REBUILD_MARKS: { rel: string; dir: boolean }[] = [
  { rel: 'package.json', dir: false },
  { rel: 'tailwind.config.cjs', dir: false },
  { rel: 'src/app', dir: true },
  { rel: 'src/styles', dir: true },
];

/**
 * the project is a rebuild before a single byte is written into it: the codemod regenerates
 * the theme and deletes the source faces early, so a mistyped --project would be left with a
 * tailwind config, a fonts.css and a fonts dir of someone else's brand and no report saying so.
 */
async function refuseNotARebuild(project: string): Promise<void> {
  const missing: string[] = [];
  for (const mark of REBUILD_MARKS) {
    const there = await fs.stat(path.join(project, ...mark.rel.split('/'))).then(
      (s) => (mark.dir ? s.isDirectory() : s.isFile()),
      () => false,
    );
    if (!there) missing.push(mark.rel);
  }
  if (missing.length) {
    throw new Error(
      `${project} is not a rebuild: no ${missing.join(', no ')}; --project takes the project the scaffold wrote`,
    );
  }
}

/**
 * the gate step, injectable so a test can fail it without a browser. the default opens a
 * session of its own and closes it before it returns, so the caller's dev server is stopped
 * after the browser is down whichever way this ends.
 */
export type GateStep = (opts: {
  root: string;
  target: string;
  brand: Brand;
  log: (line: string) => void;
}) => Promise<GateResult>;

const openAndGate: GateStep = async (opts) => {
  const session: Session = await openSession({});
  try {
    return await gateStructure({ ...opts, session });
  } finally {
    await session.close().catch((err: unknown) => {
      opts.log(
        `closing the browser session failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
};

export interface BrandResult {
  /** deviations.md, absolute */
  report: string;
  run: string;
  /** project-relative files whose bytes differ from before the run, the formatted result counted */
  changed: string[];
  theme: ThemeChange;
  logos: LogoChange;
  names: NamesChange;
  leftovers: Leftover[];
  gate: GateResult;
}

/**
 * `site brand` (spec section 7, phase two): the codemod, then the gate, then the report. the
 * theme and the faces are regenerated from the pack with the brand over them, the logos are
 * copied in under their asset names, the names are substituted over every source file, the
 * files that changed are formatted by the project's own prettier, and what differs on disk
 * afterwards is the change list: a second run finds nothing to change. then the structure
 * diff runs over every captured page of the pack against the rebuild (started with
 * `npm run dev` unless a target is given) under brand normalisation, and deviations.md is
 * written in the project. the dev server logs under the pack's runs/brand-<time>/, where the
 * next build finds and stops one a kill left behind, the way it finds a build's.
 *
 * a project that is not a rebuild (no package.json, no tailwind.config.cjs, no src/app, no
 * src/styles) is refused before the first write, naming what is missing: a mistyped --project
 * is not half-branded.
 *
 * a step that throws (a logo key that matches nothing, a prettier the project cannot resolve,
 * a browser that would not open, a dev server that died under the gate) does not swallow what
 * landed before it: deviations.md is written with the step, the failure and the verdict
 * `error`, its change list taken from the disk as it stands, and the error is raised again, so
 * the cli still exits 1 with the message and the project is never branded without a record.
 */
export async function brandProject(opts: {
  root: string;
  project: string;
  brandFile: string;
  target?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** the gate itself; the default opens a browser and runs `gateStructure` */
  gate?: GateStep;
}): Promise<BrandResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const root = path.resolve(opts.root);
  const project = path.resolve(opts.project);
  const loaded = await loadBrand(opts.brandFile);
  await refuseNotARebuild(project);
  const manifest = await loadManifest(root);
  const at = new Date().toISOString();
  const run = await freeRunName(root, `brand-${runName()}`);
  const runPaths = new RunPaths(root, run);
  const report = path.join(project, DEVIATIONS_FILE);

  const before = await snapshotTree(project);
  let theme: ThemeChange = { colors: [], fonts: [], copied: [], removed: [] };
  let logos: LogoChange = { replaced: [], unchanged: [] };
  let names: NamesChange = { counts: {}, files: {} };
  let leftovers: Leftover[] = [];
  let changed: string[] = [];
  const write = (result: GateResult | null, failed?: { step: string; message: string }) =>
    fs.writeFile(
      report,
      deviationsText({
        brandFile: loaded.file,
        project,
        root,
        at,
        run,
        manifest,
        brand: loaded.brand,
        changed,
        theme,
        logos,
        names,
        leftovers,
        gate: result,
        error: failed?.message,
        step: failed?.step,
      }),
    );
  let dev: DevServer | null = null;
  let gate: GateResult;
  // the step the run is in, so a throw says where it stopped; every step is inside the try,
  // because the theme has rewritten the config and deleted the source faces by the time the
  // logos, the names or the project's own prettier can fail
  let step = 'theme write';
  try {
    theme = await writeTheme(project, root, loaded);
    step = 'logo copy';
    logos = await replaceLogos(project, loaded);
    step = 'name substitution';
    names = await applyNames(project, loaded.brand.names);
    step = 'formatting';
    const written = diffTrees(before, await snapshotTree(project));
    await formatFiles(project, written, opts.env);
    changed = diffTrees(before, await snapshotTree(project));
    step = 'leftover scan';
    leftovers = await familyLeftovers(project, loaded.brand);
    log(`${changed.length} files changed`);

    step = 'gate';
    let target = opts.target;
    if (!target) {
      await killStaleDevServers(root, run, log);
      dev = await startDevServer({ project, log: runPaths.devServerLog, env: opts.env });
      target = dev.url;
      log(`dev server up at ${target}`);
    }
    gate = await (opts.gate ?? openAndGate)({ root, target, brand: loaded.brand, log });
  } catch (err) {
    // whatever has landed on disk is the project's now: a run that never finished still owes
    // it the record of what was written and where it stopped, and the caller the error, so the
    // cli exits 1 with the message. the change list is taken again here, by bytes, because a
    // step before the formatting never computed one
    const message = err instanceof Error ? err.message : String(err);
    try {
      changed = diffTrees(before, await snapshotTree(project));
    } catch {
      /* a tree that cannot be read is not the failure to report */
    }
    await write(null, { step, message }).catch(() => {
      /* the step's own failure is the one to raise */
    });
    throw err;
  } finally {
    // the browser is closed by the gate step itself, so the dev server is stopped after it
    if (dev) {
      const started = dev;
      await started.stop().catch((err: unknown) => {
        log(`stopping the dev server failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }
  await write(gate);
  return { report, run, changed, theme, logos, names, leftovers, gate };
}

// claude: the brand phase keeps data-section and data-ref on the components, where spec
// section 7 says phase two strips them: the gate above matches ours to the source by
// data-section first, and the shared chrome layouts take the id as a prop from their wrapper
// stubs, so the strip is a second codemod (the layouts' prop and every caller) after which the
// gate would match by path or order alone. a later milestone, once a real brand has run.
