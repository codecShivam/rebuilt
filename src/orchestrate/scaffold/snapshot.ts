import fs from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

/** the pinned bulletproof-react tree the scaffold starts from */
export const SNAPSHOT = {
  repo: 'alan2207/bulletproof-react',
  /** the latest commit touching apps/nextjs-app on 2026-09-18: "Upgrade @playwright/test and its dependencies to fix CI (#259)", 2026-04-30 */
  commit: '79710ebadede09623d11e0ab702eff30f237df5c',
  subdir: 'apps/nextjs-app',
} as const;

/** the snapshot files copied byte for byte; everything else in a scaffold is generated (template.ts) */
export const VERBATIM: readonly string[] = [
  'tsconfig.json',
  '.prettierrc',
  '.prettierignore',
  '.gitignore',
  'next-env.d.ts',
  'postcss.config.cjs',
  'src/utils/cn.ts',
  'src/hooks/use-disclosure.ts',
  'public/robots.txt',
];
/** what the prune reads from the snapshot: the vendored set under test/fixtures/scaffold */
export const SNAPSHOT_FILES: readonly string[] = [...VERBATIM, 'package.json'];

export function tarballUrl(): string {
  return `https://codeload.github.com/${SNAPSHOT.repo}/tar.gz/${SNAPSHOT.commit}`;
}

/** the tarball is not the pinned tree: the member the prune reads is not in it */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * the pinned tree, from a cache dir: the tarball is fetched once into
 * <cacheDir>/bulletproof-react-<commit>.tar.gz and apps/nextjs-app extracted next to it.
 * a second call finds the extracted tree and touches the network not at all.
 */
export async function fetchSnapshot(opts: {
  cacheDir: string;
  fetch?: typeof globalThis.fetch;
}): Promise<string> {
  const dir = path.join(opts.cacheDir, `bulletproof-react-${SNAPSHOT.commit}`);
  const tree = path.join(dir, SNAPSHOT.subdir);
  if (await exists(path.join(tree, 'package.json'))) return tree;
  const tarball = path.join(opts.cacheDir, `bulletproof-react-${SNAPSHOT.commit}.tar.gz`);
  await fs.mkdir(opts.cacheDir, { recursive: true });
  if (!(await exists(tarball))) {
    const res = await (opts.fetch ?? globalThis.fetch)(tarballUrl());
    if (!res.ok) throw new Error(`${tarballUrl()}: http ${res.status}`);
    // a download the machine interrupts must not leave a truncated file under the real name,
    // where the next run's exists() would take it for a complete one
    const partial = `${tarball}.${process.pid}.part`;
    await fs.writeFile(partial, Buffer.from(await res.arrayBuffer()));
    await fs.rename(partial, tarball);
  }
  // github's tarball has one top-level dir, bulletproof-react-<commit>/; only the subdir is extracted
  const member = `bulletproof-react-${SNAPSHOT.commit}/${SNAPSHOT.subdir}`;
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const r = await execa('tar', ['-xzf', tarball, '-C', dir, '--strip-components=1', member], {
    reject: false,
  });
  if (!(await exists(path.join(tree, 'package.json')))) {
    const why = r.stderr ? `: ${String(r.stderr).trim()}` : '';
    throw new SnapshotError(`${tarball} has no ${member}/package.json${why}`);
  }
  return tree;
}
