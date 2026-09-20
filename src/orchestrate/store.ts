import { loadManifest, saveManifest } from '../pack/io';
import type { Manifest, UnitRecord } from '../pack/schemas';
import { transition, type Event } from './state';

/**
 * the manifest in memory for one run, with every change saved before the next is applied.
 * workers run in parallel, so writers queue on one promise chain: a change is applied and saved
 * before another starts, and the file on disk is always a manifest some change produced, never
 * two half-applied ones. reads come from memory; the file is for the next run and for `site plan`.
 *
 * the callback mutates memory and the save follows it, so the two are only in step while the
 * save succeeds. a save that fails leaves memory a change ahead of disk, and the rejection goes
 * to the caller: the run aborts on it (the plan's rule) rather than working on from a manifest
 * the next run will not find. the chain itself carries on, so one failed writer does not wedge
 * the writers queued behind it.
 */
export class ManifestStore {
  private manifest: Manifest | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly root: string) {}

  async load(): Promise<Manifest> {
    this.manifest = await loadManifest(this.root);
    return this.manifest;
  }

  /** the current manifest; every write goes through update or transition */
  get(): Manifest {
    if (!this.manifest) throw new Error(`${this.root}: manifest not loaded`);
    return this.manifest;
  }

  /** apply a change and save, after every change queued before it */
  update<T>(fn: (m: Manifest) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const m = this.get();
      const out = fn(m);
      await saveManifest(this.root, m);
      return out;
    });
    // a rejected write is the caller's to handle; the chain carries on so one failed
    // transition does not poison every writer queued behind it
    this.queue = run.catch(() => undefined);
    return run;
  }

  transition(unitId: string, event: Event): Promise<UnitRecord> {
    return this.update((m) => transition(m, unitId, event));
  }
}
