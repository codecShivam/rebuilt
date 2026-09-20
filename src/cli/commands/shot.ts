import type { Command } from 'commander';
import { openSession } from '../../capture/session';
import type { ViewportName } from '../../pack/defaults';
import { shootUnit } from '../../verify/shot';
import { absoluteArg, viewportArg } from '../args';

export function registerShot(program: Command): void {
  program
    .command('shot')
    .description(
      "screenshot a unit on the rebuild as verify reaches it: the full page per viewport and a section's own crop",
    )
    .requiredOption('--pack <dir>', 'pack directory', absoluteArg)
    .requiredOption('--unit <id>', 'unit id, e.g. page:index or page:index#s02-hero-x')
    .requiredOption('--target <url>', 'base url of the rebuild')
    .requiredOption('--out <dir>', 'where the pngs go', absoluteArg)
    .option('--viewport <name>', 'one viewport only (mobile or desktop)', viewportArg)
    .action(
      async (o: {
        pack: string;
        unit: string;
        target: string;
        out: string;
        viewport?: ViewportName;
      }) => {
        const session = await openSession({});
        try {
          const r = await shootUnit({
            root: o.pack,
            unitId: o.unit,
            target: o.target,
            session,
            outDir: o.out,
            viewports: o.viewport ? [o.viewport] : undefined,
          });
          for (const f of r.files) {
            console.log(
              f.box
                ? `${f.file}  (box x ${Math.round(f.box.x)}, y ${Math.round(f.box.y)}, w ${Math.round(f.box.width)}, h ${Math.round(f.box.height)})`
                : f.file,
            );
          }
          for (const n of r.notes) console.log(`note: ${n}`);
          process.exitCode = r.files.length ? 0 : 1;
        } finally {
          await session.close();
        }
      },
    );
}
