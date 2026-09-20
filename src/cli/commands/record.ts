import type { Command } from 'commander';
import { startRecording } from '../../capture/record';
import { openSession } from '../../capture/session';
import { loadManifest } from '../../pack/io';
import { PackPaths } from '../../pack/paths';
import { absoluteArg, flowArg } from '../args';
import { withPackLock } from '../lock';

export function registerRecord(program: Command): void {
  program
    .command('record')
    .description(
      'open a visible browser on the pack profile and record a flow until the window closes',
    )
    .argument('<flow>', 'flow name (lowercase letters, digits, hyphens)', flowArg)
    .requiredOption('--pack <dir>', 'pack directory (sites/<host>)', absoluteArg)
    .option('--start <url>', "where the flow starts (default: the pack's source url)")
    .action(async (flow: string, o: { pack: string; start?: string }) => {
      const pack = new PackPaths(o.pack);
      let start = o.start;
      if (!start) {
        try {
          start = (await loadManifest(o.pack)).sourceUrl;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          throw new Error(`${o.pack} has no manifest yet; pass --start <url> or run explore first`);
        }
      }
      const from = start;
      // the lock before the browser: a refusal costs a chromium nobody asked for otherwise
      await withPackLock(o.pack, 'record', async () => {
        const session = await openSession({ profileDir: pack.profileDir, headless: false });
        try {
          const recording = await startRecording({ root: o.pack, flow, start: from, session });
          console.log(`recording "${flow}" from ${from}; close the browser window to finish`);
          const file = await recording.done;
          console.log(`${file.steps.length} steps written to ${pack.stepsFile(flow)}`);
          const inputs = [...new Set(file.steps.flatMap((s) => (s.input ? [s.input] : [])))];
          if (inputs.length) {
            console.log(
              `inputs to set under manifest.flows.${flow}.inputs before replay: ${inputs.join(', ')}`,
            );
          }
        } finally {
          await session.close();
        }
      });
    });
}
