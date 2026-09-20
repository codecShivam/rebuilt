import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { npmInstall } from '../../src/orchestrate/scaffold/scaffold';

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * node_modules for a scaffold, installed once per package.json content under os.tmpdir()
 * and linked into the project. the first run on a machine needs the network; every later
 * run is offline. if next ever refuses a linked node_modules, replace the symlink with
 * `fs.cp(modules, link, { recursive: true })`; nothing a test asserts changes.
 */
export async function installCached(project: string): Promise<void> {
  const pkg = await fs.readFile(path.join(project, 'package.json'), 'utf8');
  const key = createHash('sha256').update(pkg).digest('hex').slice(0, 16);
  const cache = path.join(os.tmpdir(), 'site-scaffold-cache', key);
  const modules = path.join(cache, 'node_modules');
  if (!(await exists(path.join(modules, '.package-lock.json')))) {
    await fs.mkdir(cache, { recursive: true });
    await fs.writeFile(path.join(cache, 'package.json'), pkg);
    await npmInstall(cache);
  }
  const link = path.join(project, 'node_modules');
  await fs.rm(link, { recursive: true, force: true });
  await fs.symlink(modules, link, 'dir');
}
