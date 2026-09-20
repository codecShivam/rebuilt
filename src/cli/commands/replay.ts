import { InvalidArgumentError, type Command } from 'commander';
import { replayFlow } from '../../capture/flows';
import { openSession } from '../../capture/session';
import { PackPaths } from '../../pack/paths';
import { verifyFlow } from '../../verify/flow';
import { summarise } from '../../verify/report';
import { absoluteArg, flowArg } from '../args';
import { withPackLock } from '../lock';

export function registerReplay(program: Command): void {
  program
    .command('replay')
    .description(
      'walk a recorded flow headless and capture each step as a flow unit; with --target, verify each step against the rebuild instead',
    )
    .argument('<flow>', 'flow name', flowArg)
    .requiredOption('--pack <dir>', 'pack directory (sites/<host>)', absoluteArg)
    .option('--target <url>', 'base url of the rebuild: verify every step instead of capturing')
    .option('--profile', 'use the pack profile dir (persistent browser profile)')
    .option('--headed', 'show the browser')
    .option(
      '--attach <endpoint>',
      'connect over cdp to a chrome started with --remote-debugging-port, e.g. http://127.0.0.1:9222',
    )
    .option('--keep-frames', 'keep frames/ next to each video (default: written, then removed)')
    .action(
      async (
        flow: string,
        o: {
          pack: string;
          target?: string;
          profile?: boolean;
          headed?: boolean;
          attach?: string;
          keepFrames?: boolean;
        },
      ) => {
        if (o.attach && o.profile) {
          throw new InvalidArgumentError(
            "--attach uses the attached chrome's own profile; drop --profile",
          );
        }
        const walk = async () => {
          // the rebuild is a site of its own: it is walked in a fresh session, never on the
          // source's profile or in the chrome attached to the source
          const session = await openSession(
            o.target
              ? { headless: !o.headed }
              : {
                  profileDir: o.profile ? new PackPaths(o.pack).profileDir : undefined,
                  headless: !o.headed,
                  attach: o.attach,
                },
          );
          try {
            if (o.target) {
              const results = await verifyFlow({ root: o.pack, flow, target: o.target, session });
              for (const r of results) console.log(summarise(r));
              process.exitCode = results.every((r) => r.verdict === 'pass') ? 0 : 1;
            } else {
              const r = await replayFlow({
                root: o.pack,
                flow,
                session,
                keepFrames: o.keepFrames ?? false,
              });
              console.log(`${flow}: captured ${r.captured.length}, blocked ${r.blocked.length}`);
              for (const id of r.captured) console.log(`  ${id}`);
              for (const id of r.blocked) console.log(`  blocked: ${id}`);
              if (r.blocked.length) process.exitCode = 1;
            }
          } finally {
            await session.close();
          }
        };
        // with --target this reads the pack and writes nothing: it verifies the rebuild and
        // reports, so a build working the pack is no reason to refuse it. capturing the flow
        // writes the manifest like any other capture, and takes the lock before the browser
        if (o.target) await walk();
        else await withPackLock(o.pack, 'replay', walk);
      },
    );
}
