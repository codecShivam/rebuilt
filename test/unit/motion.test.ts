import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listFrames } from '../../src/capture/motion';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'site-motion-unit-'));
}

describe('listFrames', () => {
  it('sorts by numeric frame index, so seg-10000.png follows seg-9999.png', async () => {
    const dir = await tmp();
    for (const name of ['seg-9999.png', 'seg-10000.png', 'seg-10001.png']) {
      await fs.writeFile(path.join(dir, name), '');
    }
    expect(await listFrames(dir, 'seg')).toEqual([
      path.join(dir, 'seg-9999.png'),
      path.join(dir, 'seg-10000.png'),
      path.join(dir, 'seg-10001.png'),
    ]);
  });
});
