import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { fetchSnapshot } from './snapshot';
import { generateFromPack, pruneSnapshot, type Generated } from './generate';

export function defaultCacheDir(): string {
  return path.join(os.homedir(), '.cache', 'site');
}

// claude: one of five copies of this exists() helper (snapshot.ts, here, generate.ts,
// cli/commands/scaffold.ts, test/helpers/scaffold-cache.ts); a shared fs util is a later task
async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** the install the readme prescribes for this repo works for the scaffold too; output is kept for the error */
export async function npmInstall(project: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const r = await execa(
    'npm',
    ['install', '--legacy-peer-deps', '--no-audit', '--no-fund', '--loglevel', 'error'],
    { cwd: project, env, extendEnv: true, reject: false, stdout: 'ignore', stderr: 'pipe' },
  );
  if (r.exitCode !== 0) {
    throw new Error(`npm install in ${project} failed (${r.exitCode ?? r.signal}): ${r.stderr}`);
  }
}

/** the project's own prettier over the generated files, so `next lint`'s prettier rule starts clean */
export async function formatProject(project: string, env?: NodeJS.ProcessEnv): Promise<void> {
  await execa('npx', ['prettier', '--write', '.', '--log-level', 'warn'], {
    cwd: project,
    env,
    extendEnv: true,
  });
}

export interface ScaffoldOptions {
  out: string;
  /** the package name, `<host>-rebuild` from the cli */
  name: string;
  /** a pack to generate the features, routes, tokens, fonts and assets from */
  root?: string;
  /** a local copy of the snapshot tree (the vendored fixture under test) instead of the fetch */
  source?: string;
  cacheDir?: string;
  /** false skips npm install and the format that follows it */
  install?: boolean;
  /** the installer itself, so a test can fail one without waiting for npm; defaults to npmInstall */
  installer?: (project: string, env?: NodeJS.ProcessEnv) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/**
 * the blank rebuild: prune the pinned snapshot into `out`, generate the pack's features,
 * routes, chrome, theme, fonts and assets over it, install, format. refuses a dir that
 * already holds a project, because a scaffold over a rebuild in progress would erase it.
 * anything after the prune that fails takes the scaffold with it: a half-written dir would
 * only meet the refusal above on the retry an operator reaches for first.
 */
export async function scaffoldProject(
  opts: ScaffoldOptions,
): Promise<{ project: string; source: string; generated: Generated | null }> {
  const out = path.resolve(opts.out);
  if (await exists(path.join(out, 'package.json'))) {
    throw new Error(`${out} already has a package.json; scaffold into an empty dir`);
  }
  const existed = await exists(out);
  // what the clean-up must leave alone: an operator's own files in a dir that was already there.
  // a dir this call created goes whole.
  const before = existed ? new Set(await fs.readdir(out)) : new Set<string>();
  const source =
    opts.source ?? (await fetchSnapshot({ cacheDir: opts.cacheDir ?? defaultCacheDir() }));
  await pruneSnapshot(source, out, { name: opts.name });
  let generated: Generated | null = null;
  try {
    if (opts.root) generated = await generateFromPack({ root: opts.root, project: out });
    if (opts.install !== false) {
      await (opts.installer ?? npmInstall)(out, opts.env);
      await formatProject(out, opts.env);
    }
  } catch (err) {
    if (existed) {
      for (const entry of await fs.readdir(out)) {
        if (!before.has(entry))
          await fs.rm(path.join(out, entry), { recursive: true, force: true });
      }
    } else {
      await fs.rm(out, { recursive: true, force: true });
    }
    throw new Error(
      `${err instanceof Error ? err.message : String(err)}; ${out} was cleaned up, so the scaffold can be run again`,
    );
  }
  return { project: out, source, generated };
}
