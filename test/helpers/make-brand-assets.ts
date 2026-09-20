import { PNG } from 'pngjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const dir = path.resolve('test/fixtures/brand');
const site = path.resolve('test/fixtures/site');

/** 480 by 270 like the fixture's hero, in the brand's red, so a replaced logo is told apart by eye and by bytes */
async function writeLogoPng() {
  const png = new PNG({ width: 480, height: 270 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const i = (png.width * y + x) << 2;
      png.data[i] = 225;
      png.data[i + 1] = 29 + Math.floor((y / png.height) * 60);
      png.data[i + 2] = 72;
      png.data[i + 3] = 255;
    }
  }
  await fs.writeFile(path.join(dir, 'logo.png'), PNG.sync.write(png));
}

/** the brand's two faces are the fixture's own Inter bytes under the brand's names (OFL; fonts/README.md) */
async function copyFaces() {
  await fs.mkdir(path.join(dir, 'fonts'), { recursive: true });
  for (const name of ['Acme-Regular.woff2', 'Acme-Bold.woff2']) {
    await fs.copyFile(
      path.join(site, 'fonts', 'Fixture-Regular.woff2'),
      path.join(dir, 'fonts', name),
    );
  }
}

await writeLogoPng();
await copyFaces();
console.log('brand fixture assets ready');
