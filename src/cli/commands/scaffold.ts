import fs from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { scaffoldProject } from '../../orchestrate/scaffold/scaffold';
import { SNAPSHOT } from '../../orchestrate/scaffold/snapshot';
import { absoluteArg } from '../args';

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

export function registerScaffold(program: Command): void {
  program
    .command('scaffold <host>')
    .description(
      "create the rebuild project for a host: bulletproof-react's nextjs app at the pinned commit, demo removed, the pack's sections as stubs",
    )
    .option(
      '--pack <dir>',
      'the pack to generate from (default sites/<host> when it exists)',
      absoluteArg,
    )
    .option('--out <dir>', 'project directory (default builds/<host>)', absoluteArg)
    .option('--source <dir>', 'a local copy of the snapshot tree instead of fetching it')
    .option('--cache <dir>', 'where the fetched snapshot is kept (default ~/.cache/site)')
    .option('--no-install', 'skip npm install')
    .action(
      async (
        host: string,
        o: { pack?: string; out?: string; source?: string; cache?: string; install: boolean },
      ) => {
        const defaultPack = path.resolve('sites', host);
        const root =
          o.pack ??
          ((await exists(path.join(defaultPack, 'manifest.json'))) ? defaultPack : undefined);
        const r = await scaffoldProject({
          out: o.out ?? path.resolve('builds', host),
          name: `${host}-rebuild`,
          root,
          source: o.source,
          cacheDir: o.cache,
          install: o.install,
        });
        const from = `${SNAPSHOT.repo}@${SNAPSHOT.commit.slice(0, 7)}`;
        const g = r.generated;
        console.log(
          g
            ? `${r.project}: scaffolded from ${from} and ${root}: ${g.features.length} features, ${g.components.length} components, ${g.routes.length} routes, ${g.layouts.length} layouts, ${g.fonts.length} fonts, ${g.assets.length} assets${o.install ? ', installed' : ''}`
            : `${r.project}: scaffolded from ${from}${o.install ? ', installed' : ''}`,
        );
      },
    );
}
