import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson } from '../pack/io';
import { PackPaths } from '../pack/paths';
import { LockFileSchema, type LockFile } from '../pack/schemas';

export class LockError extends Error {
  constructor(
    readonly file: string,
    readonly holder: LockFile,
  ) {
    super(
      `${file}: another build (pid ${holder.pid}, run ${holder.run}, since ${holder.startedAt}) holds this pack; stop it or wait for it, or delete ${file} if that process is not a site build`,
    );
    this.name = 'LockError';
  }
}

/** signal 0 probes without killing; EPERM means the process exists and is someone else's. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * how often a starter looks before giving up. every loop past the first means the lock changed
 * under it (a holder released, or another starter is reclaiming the same dead one); that settles
 * in a loop or two, so a handful is already generous.
 */
const ATTEMPTS = 5;
/** how long another starter may hold the reclaim before this one treats it as killed, ms */
const RECLAIM_ABANDONED_MS = 10_000;
/** how long to wait before looking again while another starter is inside the reclaim, ms */
const RETRY_DELAY_MS = 25;

export interface AcquireOptions {
  /** how a holder's pid is probed; a test injects a dead one */
  alive?: (pid: number) => boolean;
  /** how often to look before giving up */
  attempts?: number;
  /** how long to wait while another starter is inside the reclaim, ms */
  delayMs?: number;
}

/** what is at the lock path right now: nothing, something that is not a lock, or a holder. */
type Holder =
  { state: 'gone' } | { state: 'corrupt'; raw: string } | { state: 'held'; record: LockFile };

async function readHolder(file: string): Promise<Holder> {
  try {
    return { state: 'held', record: await readJson(LockFileSchema, file) };
  } catch (err) {
    if (errno(err) === 'ENOENT') return { state: 'gone' };
  }
  // there but not a lock file: a half-written or hand-edited leftover holds nobody. its bytes
  // are kept so the reclaim can still tell whether what it is about to delete has changed.
  try {
    return { state: 'corrupt', raw: await fs.readFile(file, 'utf8') };
  } catch (err) {
    if (errno(err) === 'ENOENT') return { state: 'gone' };
    throw err;
  }
}

/** the same thing on disk, by every field: a record that differs at all is somebody else's. */
function sameHolder(before: Holder, after: Holder): boolean {
  if (before.state === 'held' && after.state === 'held') {
    return (
      before.record.pid === after.record.pid &&
      before.record.run === after.record.run &&
      before.record.startedAt === after.record.startedAt
    );
  }
  if (before.state === 'corrupt' && after.state === 'corrupt') return before.raw === after.raw;
  return false;
}

/**
 * the reclaim mutex: a directory next to the lock, because mkdir is the other exclusive create
 * a filesystem gives us. true means this starter is inside it and must release it; false means
 * look again. a starter killed inside the mutex leaves the directory behind, so one older than
 * RECLAIM_ABANDONED_MS is removed rather than waited on.
 */
async function enterReclaim(dir: string, delayMs: number): Promise<boolean> {
  try {
    await fs.mkdir(dir);
    return true;
  } catch (err) {
    if (errno(err) !== 'EEXIST') throw err;
  }
  let age: number;
  try {
    age = Date.now() - (await fs.stat(dir)).mtimeMs;
  } catch (err) {
    if (errno(err) === 'ENOENT') return false;
    throw err;
  }
  if (age > RECLAIM_ABANDONED_MS) await fs.rmdir(dir).catch(() => {});
  else await sleep(delayMs);
  return false;
}

async function create(file: string, record: LockFile): Promise<boolean> {
  try {
    await fs.writeFile(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    return true;
  } catch (err) {
    if (errno(err) === 'EEXIST') return false;
    throw err;
  }
}

/**
 * one orchestrator per pack: runs/.lock names the holder. the exclusive create is what a
 * starter wins with, so two starters never both take a free lock. a holder whose process is
 * gone was killed, and so is a file that no longer reads as a lock; either is reclaimed, but
 * only under the reclaim mutex and only while the record is still the exact one this starter
 * judged dead. that pair is what keeps a slow starter from deleting the fresh lock of the
 * starter that reclaimed before it. returns the release function; the caller runs it on every
 * exit path.
 */
export async function acquireLock(
  root: string,
  run: string,
  opts: AcquireOptions = {},
): Promise<() => Promise<void>> {
  const file = new PackPaths(root).lock;
  const reclaimDir = `${file}.reclaim`;
  const alive = opts.alive ?? processAlive;
  const attempts = opts.attempts ?? ATTEMPTS;
  const delayMs = opts.delayMs ?? RETRY_DELAY_MS;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const record: LockFile = { pid: process.pid, run, startedAt: new Date().toISOString() };
  const release = async () => {
    await fs.rm(file, { force: true });
  };
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await create(file, record)) return release;
    const holder = await readHolder(file);
    // gone between the create and the read: the holder released it, so go take it
    if (holder.state === 'gone') continue;
    if (holder.state === 'held' && alive(holder.record.pid))
      throw new LockError(file, holder.record);
    if (!(await enterReclaim(reclaimDir, delayMs))) continue;
    try {
      // inside the mutex nobody else is between a check and a delete, so a record that still
      // reads as the dead one is the dead one, and deleting it cannot take anyone's live lock
      if (!sameHolder(holder, await readHolder(file))) continue;
      await fs.rm(file, { force: true });
      if (await create(file, record)) return release;
    } finally {
      await fs.rmdir(reclaimDir).catch(() => {});
    }
  }
  throw new Error(
    `${file}: could not take the lock in ${attempts} attempts; it kept changing under us, so look at it and delete it if no build is running`,
  );
}
