import { InvalidArgumentError, type Command } from 'commander';
import { captureAll } from '../../capture/capture-all';
import { openSession } from '../../capture/session';
import { PackPaths } from '../../pack/paths';
import { absoluteArg } from '../args';
import { withPackLock } from '../lock';

export function registerCapture(program: Command): void {
  program
    .command('capture')
    .description('capture every planned unit in a pack')
    .requiredOption('--pack <dir>', 'pack directory (sites/<host>)', absoluteArg)
    .option('--unit <id>', 'capture one unit only')
    .option('--profile', 'use the pack profile dir (persistent browser profile)')
    .option('--headed', 'show the browser')
    .option(
      '--attach <endpoint>',
      'connect over cdp to a chrome started with --remote-debugging-port, e.g. http://127.0.0.1:9222',
    )
    .option('--keep-frames', 'keep frames/ next to each video (default: written, then removed)')
    .action(
      async (o: {
        pack: string;
        unit?: string;
        profile?: boolean;
        headed?: boolean;
        attach?: string;
        keepFrames?: boolean;
      }) => {
        if (o.attach && o.profile) {
          throw new InvalidArgumentError(
            "--attach uses the attached chrome's own profile; drop --profile",
          );
        }
        // the lock before the browser: a refusal costs a chromium nobody asked for otherwise
        await withPackLock(o.pack, 'capture', async () => {
          const session = await openSession({
            profileDir: o.profile ? new PackPaths(o.pack).profileDir : undefined,
            headless: !o.headed,
            attach: o.attach,
          });
          try {
            const r = await captureAll({
              root: o.pack,
              session,
              only: o.unit,
              keepFrames: o.keepFrames ?? false,
            });
            console.log(`captured ${r.captured.length}, blocked ${r.blocked.length}`);
            for (const b of r.blocked) console.log(`  blocked: ${b}`);
          } finally {
            await session.close();
          }
        });
      },
    );
}
