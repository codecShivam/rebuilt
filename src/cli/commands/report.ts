import type { Command } from 'commander';
import { latestRun, writeReport } from '../../orchestrate/report';
import { absoluteArg } from '../args';

export function registerReport(program: Command): void {
  program
    .command('report')
    .description('write runs/<run>/report.md from the manifest and the run log, and print its path')
    .requiredOption('--pack <dir>', 'pack directory', absoluteArg)
    .option('--run <name>', 'a run under runs/ (default: the latest)')
    .action(async (o: { pack: string; run?: string }) => {
      const run = o.run ?? (await latestRun(o.pack));
      if (!run) throw new Error(`${o.pack}: no runs yet; run site build first`);
      console.log(await writeReport(o.pack, run));
    });
}
