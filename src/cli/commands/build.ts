import path from 'node:path';
import type { Command } from 'commander';
import { build, QuestionsOpenError } from '../../orchestrate/build';
import { ORCHESTRATE } from '../../orchestrate/defaults';
import { LockError } from '../../orchestrate/lock';
import { writeReport } from '../../orchestrate/report';
import { loadManifest } from '../../pack/io';
import { absoluteArg, claudeArg, gateArg, positiveIntArg } from '../args';

export function registerBuild(program: Command): void {
  program
    .command('build')
    .description(
      'work the queue: a claude worker per unit, verified by this tool from its own browser, reviewed by a second worker; resumable',
    )
    .requiredOption('--pack <dir>', 'pack directory', absoluteArg)
    .option('--project <dir>', 'the rebuild (default builds/<host>)', absoluteArg)
    .option(
      '--target <url>',
      'a running rebuild; without it, npm run dev is started in the project',
    )
    .option(
      '--parallel <n>',
      'workers on independent pages at once',
      positiveIntArg,
      ORCHESTRATE.parallel,
    )
    .option('--rounds <n>', 'rounds per unit before it blocks', positiveIntArg, ORCHESTRATE.rounds)
    .option('--threshold <fraction>', 'pixel mismatch gate for every unit', gateArg)
    .option('--claude <bin>', 'the claude binary', claudeArg, 'claude')
    .option('--reopen <unit...>', 'blocked units to put back in the queue first')
    .option(
      '--model <name>',
      "model alias for the workers (sonnet, haiku, opus); default: the binary's own",
    )
    .option('--reviewer-model <name>', "the reviewer's model when it differs from --model")
    .action(
      async (o: {
        pack: string;
        project?: string;
        target?: string;
        parallel: number;
        rounds: number;
        threshold?: number;
        claude: string;
        reopen?: string[];
        model?: string;
        reviewerModel?: string;
      }) => {
        const manifest = await loadManifest(o.pack);
        const project = o.project ?? path.resolve('builds', manifest.host);
        try {
          const r = await build({
            root: o.pack,
            project,
            target: o.target,
            parallel: o.parallel,
            rounds: o.rounds,
            threshold: o.threshold,
            claude: o.claude,
            reopen: o.reopen,
            models: { builder: o.model, reviewer: o.reviewerModel ?? o.model },
          });
          // build already logged its own `done: ...` summary; this line names the report and
          // nothing else. what the run did is what the exit code answers for, and a report
          // that could not be written says so on stderr rather than losing the run's own line
          process.exitCode = r.blocked.length ? 1 : r.interrupted.length ? 2 : 0;
          try {
            console.log(`report: ${await writeReport(o.pack, r.run)}`);
          } catch (err) {
            console.error(
              `could not write the report for run ${r.run}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } catch (err) {
          // a refusal is the tool's answer, not a crash: the reason is enough, without a stack
          if (err instanceof QuestionsOpenError || err instanceof LockError) {
            console.error(err.message);
            process.exitCode = 1;
            return;
          }
          throw err;
        }
      },
    );
}
