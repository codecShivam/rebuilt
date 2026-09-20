import fs from 'node:fs/promises';
import path from 'node:path';
import type { ZodType } from 'zod';
import { DEFAULT_VIEWPORTS, SETTLE } from './defaults';
import { ManifestSchema, type Manifest } from './schemas';
import { PackPaths } from './paths';
import { TOOL_VERSION } from '../version';

export async function readJson<T>(schema: ZodType<T>, file: string): Promise<T> {
  const raw = await fs.readFile(file, 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${file}: invalid json: ${message}`);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first ? first.path.join('.') || '(root)' : '(unknown)';
    const why = first ? first.message : 'invalid';
    throw new Error(`${file}: schema failure at ${where}: ${why}`);
  }
  return parsed.data;
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
}

/**
 * the same write through a temp sibling and a rename: a file rewritten whole while a run is
 * going (the run log) is either the last version or this one, never half of one, whatever a
 * kill lands in the middle of. `mode` is set on the temp file before the rename, so the file
 * that appears has it from its first moment and a leftover temp cannot keep a wider one (the
 * browser session's files are this user's alone; see driver.ts).
 */
export async function writeJsonAtomic(
  file: string,
  value: unknown,
  opts: { mode?: number } = {},
): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeJson(tmp, value);
  if (opts.mode !== undefined) await fs.chmod(tmp, opts.mode);
  await fs.rename(tmp, file);
}

/**
 * the same temp sibling and rename for bytes the caller has already shaped. the brand codemod
 * rewrites a component and a logo in place; a kill mid-write must leave the file it was
 * rewriting whole, so the rerun reads something it can still parse and codemod again.
 */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

/**
 * build into a temp sibling, then rename into place. on failure nothing is left behind.
 * the old dir is renamed aside rather than deleted, so a kill between the two renames
 * leaves either the old capture or the new one, never nothing. subdirs named in `keep`
 * are moved from the old dir into the new one before the swap: a page's `states/` holds
 * captured units of their own, and a recapture of the page must not delete them.
 */
export async function writeDirAtomic(
  finalDir: string,
  build: (tmpDir: string) => Promise<void>,
  opts: { keep?: string[] } = {},
): Promise<void> {
  const tmp = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true });
  try {
    await build(tmp);
  } catch (err) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw err;
  }
  await fs.mkdir(path.dirname(finalDir), { recursive: true });
  const old = `${finalDir}.old-${process.pid}`;
  await fs.rm(old, { recursive: true, force: true });
  let displaced = false;
  try {
    await fs.rename(finalDir, old);
    displaced = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (displaced) {
    const merged: string[] = [];
    for (const name of opts.keep ?? []) {
      try {
        await fs.rename(path.join(old, name), path.join(tmp, name));
        merged.push(name);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        // the new build wrote something under a name we were told to keep: put back any
        // names already merged into `tmp` before restoring `old`, so `old` is whole again
        for (const m of merged) await fs.rename(path.join(tmp, m), path.join(old, m));
        // the displaced dir is whole again; restore it so `finalDir` still exists, then
        // surface the collision as a bug rather than merging it silently
        try {
          await fs.rename(old, finalDir);
        } catch (restoreErr) {
          // the filesystem is misbehaving; leave `tmp` and `old` in place rather than
          // deleting anything, and let the operator sort it out
          const message = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
          throw new Error(
            `${finalDir}: cannot keep ${name} and could not restore ${old}: ${message}`,
          );
        }
        await fs.rm(tmp, { recursive: true, force: true });
        throw new Error(`${finalDir}: cannot keep ${name}: the new build also wrote it (${code})`);
      }
    }
  }
  await fs.rename(tmp, finalDir);
  if (displaced) {
    // the new dir is in place; a displaced dir that cannot be removed is a leftover to
    // report, not a reason to fail a capture that already succeeded
    try {
      await fs.rm(old, { recursive: true, force: true });
    } catch (err) {
      console.warn(`could not remove ${old}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function newManifest(opts: { host: string; sourceUrl: string }): Manifest {
  return {
    host: opts.host,
    sourceUrl: opts.sourceUrl,
    createdAt: new Date().toISOString(),
    toolVersion: TOOL_VERSION,
    viewports: { mobile: DEFAULT_VIEWPORTS.mobile, desktop: DEFAULT_VIEWPORTS.desktop },
    capture: {
      attach: false,
      profile: false,
      fps: 30,
      crawlDepth: 2,
      scope: [],
      dynamicShots: SETTLE.dynamicShots,
      dynamicGap: SETTLE.dynamicGap,
    },
    units: {},
    questions: [],
    flows: {},
  };
}

/**
 * the manifest, refused when another tool version wrote it: the pack format froze at 0.2.0
 * (the orchestrator reads every unit file), and a unit file from an older capture would fail
 * its schema on a field it never had, pointing at the field as if the file were corrupt.
 */
export async function loadManifest(root: string): Promise<Manifest> {
  const file = new PackPaths(root).manifest;
  const manifest = await readJson(ManifestSchema, file);
  if (manifest.toolVersion !== TOOL_VERSION) {
    throw new Error(
      `${file}: written by site ${manifest.toolVersion}, this is site ${TOOL_VERSION}; the pack format changed, so explore and capture the site again into a fresh pack`,
    );
  }
  return manifest;
}

/** the queue on disk: written whole to a sibling and renamed, so a kill mid-save leaves the last saved manifest, never half of one. */
export async function saveManifest(root: string, manifest: Manifest): Promise<void> {
  ManifestSchema.parse(manifest);
  const file = new PackPaths(root).manifest;
  const tmp = `${file}.tmp-${process.pid}`;
  await writeJson(tmp, manifest);
  await fs.rename(tmp, file);
}
