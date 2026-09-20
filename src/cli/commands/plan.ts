import type { Command } from 'commander';
import { planText } from '../../orchestrate/plan';
import { loadManifest } from '../../pack/io';
import { absoluteArg } from '../args';

export function registerPlan(program: Command): void {
  program
    .command('plan')
    .description(
      'print the queue: units by status and kind, flows and their inputs, open questions',
    )
    .requiredOption('--pack <dir>', 'pack directory', absoluteArg)
    .action(async (o: { pack: string }) => {
      console.log(planText(await loadManifest(o.pack)));
    });
}
