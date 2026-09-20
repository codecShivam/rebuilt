import { PNG } from 'pngjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('test/fixtures/site');

async function writeHeroPng() {
  const png = new PNG({ width: 480, height: 270 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      png.data[i] = 37 + Math.floor((x / png.width) * 100);
      png.data[i + 1] = 99;
      png.data[i + 2] = 235 - Math.floor((y / png.height) * 100);
      png.data[i + 3] = 255;
    }
  }
  await fs.writeFile(path.join(dir, 'hero.png'), PNG.sync.write(png));
}

async function ensureFont() {
  const target = path.join(dir, 'fonts', 'Fixture-Regular.woff2');
  try {
    await fs.access(target);
    return;
  } catch {
    /* generate below */
  }
  throw new Error(
    `missing ${target}. drop any small woff2 there (for example a subset of a libre font) and rerun.`,
  );
}

await writeHeroPng();
await ensureFont();
console.log('fixture assets ready');
