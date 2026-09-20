import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { brandProject } from '../../orchestrate/brand';
import { absoluteArg } from '../args';

/** the pack a rebuild came from, by the scaffold's own naming: package.json's `<host>-rebuild` was scaffolded from sites/<host> */
export async function defaultPackFor(project: string): Promise<string> {
  let name = '';
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8')) as {
      name?: string;
    };
    name = pkg.name ?? '';
  } catch {
    name = '';
  }
  const host = name.endsWith('-rebuild') ? name.slice(0, -'-rebuild'.length) : '';
  if (!host) {
    throw new Error(`${project}/package.json does not name a <host>-rebuild, so pass --pack`);
  }
  return path.resolve('sites', host);
}

export function registerBrand(program: Command): void {
  program
    .command('brand')
    .description(
      'phase two: apply brand.json to a rebuilt project (theme tokens, font faces, logos, names), then gate it with the structure diff under brand normalisation; writes deviations.md in the project',
    )
    .requiredOption('--project <dir>', 'the rebuild', absoluteArg)
    .requiredOption(
      '--brand <file>',
      'brand.json; the files it names are relative to it',
      absoluteArg,
    )
    .option(
      '--pack <dir>',
      'the pack the project was scaffolded from (default sites/<host>, from package.json)',
      absoluteArg,
    )
    .option(
      '--target <url>',
      'a running rebuild; without it, npm run dev is started in the project',
    )
    .action(async (o: { project: string; brand: string; pack?: string; target?: string }) => {
      const r = await brandProject({
        root: o.pack ?? (await defaultPackFor(o.project)),
        project: o.project,
        brandFile: o.brand,
        target: o.target,
      });
      for (const u of r.gate.units) {
        console.log(
          `${u.unitId}: ${u.findings.length ? `fail (${u.findings.length} findings)` : 'pass'}`,
        );
      }
      for (const s of r.gate.skipped) console.log(`${s.unitId}: skipped, ${s.reason}`);
      console.log(`${r.changed.length} files changed; report: ${r.report}`);
      process.exitCode = r.gate.verdict === 'pass' ? 0 : 1;
    });
}
