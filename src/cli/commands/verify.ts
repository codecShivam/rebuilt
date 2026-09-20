import { type Command } from 'commander';
import { openSession } from '../../capture/session';
import { summarise } from '../../verify/report';
import { verifyUnit } from '../../verify/verify';
import { absoluteArg, gateArg } from '../args';

export function registerVerify(program: Command): void {
  program
    .command('verify')
    .description('capture a target and compare it with a pack unit')
    .requiredOption('--pack <dir>', 'pack directory', absoluteArg)
    .requiredOption('--unit <id>', 'unit id, e.g. page:index or page:index#s02-hero-x')
    .requiredOption('--target <url>', 'base url of the rebuild, e.g. http://localhost:3000')
    .option('--out <dir>', 'where to write verify.json and images', absoluteArg)
    .option('--gate <fraction>', 'pixel mismatch gate', gateArg)
    .action(
      async (o: { pack: string; unit: string; target: string; out?: string; gate?: number }) => {
        const session = await openSession({});
        try {
          const r = await verifyUnit({
            root: o.pack,
            unitId: o.unit,
            target: o.target,
            session,
            outDir: o.out,
            gate: o.gate,
          });
          console.log(summarise(r));
          process.exitCode = r.verdict === 'pass' ? 0 : 1;
        } finally {
          await session.close();
        }
      },
    );
}
