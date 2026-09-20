/**
 * reads `-frames:v <n>` and the last argument (the `%04d` pattern) and writes n 8x8 white
 * pngs, with its own argv next to them in argv.json so a test can hold the call to what it
 * asked for. SITE_FAKE_FFMPEG_EXIT makes it write no frames and exit with that code, which is
 * what a real ffmpeg does on a truncated recording.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const argv = process.argv.slice(2);
const frames = Number(argv[argv.indexOf('-frames:v') + 1] ?? 0);
const pattern = argv[argv.length - 1]!;
const outDir = path.dirname(pattern);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'argv.json'), JSON.stringify(argv, null, 2) + '\n');
const exit = Number(process.env['SITE_FAKE_FFMPEG_EXIT'] ?? 0);
if (exit) {
  process.stderr.write('moov atom not found\n');
  process.exit(exit);
}
for (let i = 1; i <= frames; i++) {
  const png = new PNG({ width: 8, height: 8 });
  png.data.fill(255);
  fs.writeFileSync(pattern.replace('%04d', String(i).padStart(4, '0')), PNG.sync.write(png));
}
