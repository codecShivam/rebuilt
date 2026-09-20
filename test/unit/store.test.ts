import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newManifest, readJson, saveManifest } from '../../src/pack/io';
import { PackPaths } from '../../src/pack/paths';
import { ManifestSchema, type Manifest } from '../../src/pack/schemas';
import { ManifestStore } from '../../src/orchestrate/store';

const AT = '2026-09-18T00:00:00.000Z';

/** a pack on disk holding one captured section, and a store that has loaded it */
async function store(): Promise<{ root: string; store: ManifestStore; manifest: Manifest }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'store-'));
  const m = newManifest({ host: 'x.com', sourceUrl: 'https://x.com/' });
  m.units['page:index#s01-hero'] = {
    kind: 'section',
    status: 'captured',
    dependsOn: [],
    rounds: 0,
    updatedAt: AT,
  };
  await saveManifest(root, m);
  const s = new ManifestStore(root);
  const manifest = await s.load();
  return { root, store: s, manifest };
}

describe('ManifestStore', () => {
  it('refuses to read before it has loaded', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'store-'));
    expect(() => new ManifestStore(root).get()).toThrow(/manifest not loaded/);
  });

  it('serialises writers: the second sees the first, and the file parses at every step', async () => {
    const { root, store: s } = await store();
    const file = new PackPaths(root).manifest;
    const seen: number[] = [];
    // both are started before either is awaited: without the queue they would interleave, and
    // the second would read the manifest as it was before the first touched it
    const first = s.update((m) => {
      m.units['page:index#s01-hero']!.rounds += 1;
      return m.units['page:index#s01-hero']!.rounds;
    });
    const second = s.update((m) => {
      seen.push(m.units['page:index#s01-hero']!.rounds);
      m.units['page:index#s01-hero']!.rounds += 1;
      return m.units['page:index#s01-hero']!.rounds;
    });
    // while both are pending the file is read over and over: whatever is there parses as a
    // manifest (readJson would throw otherwise) and holds a whole change, never half of one,
    // because every save goes through a temp file and a rename
    const during: number[] = [];
    let running = true;
    const stop = () => {
      running = false;
    };
    void second.then(stop, stop);
    while (running) {
      during.push((await readJson(ManifestSchema, file)).units['page:index#s01-hero']!.rounds);
    }
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(seen).toEqual([1]);
    expect(during.length).toBeGreaterThan(0);
    expect(during.every((r) => [0, 1, 2].includes(r))).toBe(true);
    // the last save is on disk, and it is the last change in memory
    expect((await readJson(ManifestSchema, file)).units['page:index#s01-hero']!.rounds).toBe(2);
    expect(s.get().units['page:index#s01-hero']!.rounds).toBe(2);
    // the temp file is renamed away, never left next to the manifest
    expect((await fs.readdir(root)).sort()).toEqual(['manifest.json']);
  });

  it('saves every transition, and a rejected one leaves the queue working', async () => {
    const { root, store: s } = await store();
    const file = new PackPaths(root).manifest;
    await s.transition('page:index#s01-hero', { type: 'build_started' });
    expect((await readJson(ManifestSchema, file)).units['page:index#s01-hero']).toMatchObject({
      status: 'building',
      rounds: 1,
    });
    // an illegal transition rejects on its own caller and nothing else
    await expect(s.transition('page:index#s01-hero', { type: 'build_started' })).rejects.toThrow(
      /build_started is not legal from building/,
    );
    await s.transition('page:index#s01-hero', { type: 'verify_started' });
    expect((await readJson(ManifestSchema, file)).units['page:index#s01-hero']).toMatchObject({
      status: 'verifying',
      rounds: 1,
    });
  });
});
