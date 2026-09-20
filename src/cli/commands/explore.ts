import { InvalidArgumentError, type Command } from 'commander';
import path from 'node:path';
import { explore } from '../../capture/explore';
import { openSession } from '../../capture/session';
import { exploreAgent } from '../../orchestrate/explorer';
import { siteBin } from '../../orchestrate/hooks';
import { PackPaths } from '../../pack/paths';
import { absoluteArg, claudeArg } from '../args';
import { withPackLock } from '../lock';

/** a mistyped depth must stop the run rather than crawl a NaN number of levels. */
function depthArg(value: string): number {
  // Number('') is 0, so only a run of digits counts as a depth
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError('depth must be a whole number of 0 or more');
  }
  return Number(value);
}

export function registerExplore(program: Command): void {
  program
    .command('explore <url>')
    .description('crawl a site and plan its page units')
    .option('--out <dir>', 'pack directory (default sites/<host>)', absoluteArg)
    .option('--depth <n>', 'crawl depth', depthArg, 2)
    .option('--scope <glob...>', 'path globs to stay within')
    .option('--profile', 'use the pack profile dir (persistent browser profile)')
    .option('--headed', 'show the browser')
    .option(
      '--attach <endpoint>',
      'connect over cdp to a chrome started with --remote-debugging-port, e.g. http://127.0.0.1:9222',
    )
    .option(
      '--agent',
      'after the crawl, an explorer worker per page marks the states and flows the crawl missed',
    )
    .option('--claude <bin>', 'the claude binary (with --agent)', claudeArg, 'claude')
    .option('--model <name>', "the explorer's model alias (with --agent)")
    .action(
      async (
        url: string,
        o: {
          out?: string;
          depth: number;
          scope?: string[];
          profile?: boolean;
          headed?: boolean;
          attach?: string;
          agent?: boolean;
          claude: string;
          model?: string;
        },
      ) => {
        if (o.attach && o.profile) {
          throw new InvalidArgumentError(
            "--attach uses the attached chrome's own profile; drop --profile",
          );
        }
        if (o.agent && (o.attach || o.profile)) {
          // the explorer drives a browser of its own on a fresh profile
          // claude: an explorer on the user's own chrome or the pack profile (a site behind a
          // login) is a later milestone
          throw new InvalidArgumentError(
            '--agent drives its own browser on a fresh profile; drop --attach and --profile',
          );
        }
        const root = o.out ?? path.resolve('sites', new URL(url).host);
        // the lock before the browser: a refusal costs a chromium nobody asked for otherwise
        await withPackLock(root, 'explore', async () => {
          const session = await openSession({
            profileDir: o.profile ? new PackPaths(root).profileDir : undefined,
            headless: !o.headed,
            attach: o.attach,
          });
          try {
            const m = await explore({ root, url, depth: o.depth, scope: o.scope ?? [], session });
            const planned = Object.values(m.units).filter((u) => u.status === 'planned').length;
            console.log(`${root}: ${Object.keys(m.units).length} units, ${planned} planned`);
          } finally {
            await session.close();
          }
          if (o.agent) {
            const r = await exploreAgent({
              root,
              claude: o.claude,
              site: siteBin(),
              model: o.model,
            });
            console.log(
              `explorer: ${r.states.length} states, ${r.flows.length} flows, ${r.questions.length} questions (runs/${r.run})`,
            );
            for (const [page, outcome] of Object.entries(r.outcomes)) {
              if (outcome !== 'done') console.log(`  ${page}: explorer ${outcome}`);
            }
          }
        });
      },
    );
}
