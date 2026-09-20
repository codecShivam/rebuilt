import { type Command } from 'commander';
import { openSession } from '../../capture/session';
import { editAllowed } from '../../orchestrate/hooks';
import { ORCHESTRATE } from '../../orchestrate/defaults';
import { processAlive } from '../../orchestrate/lock';
import { readJson, writeJsonAtomic } from '../../pack/io';
import { PackPaths } from '../../pack/paths';
import {
  AllowedFilesSchema,
  HookInputSchema,
  LockFileSchema,
  StopHookStateSchema,
  type HookInput,
  type StopHookState,
} from '../../pack/schemas';
import { summarise } from '../../verify/report';
import { verifyUnit } from '../../verify/verify';
import { absoluteArg, gateArg, positiveIntArg } from '../args';

/** the one line both hooks give a worker whose orchestrator was killed under it */
const ORPHANED = 'the orchestrator that started this worker is gone';

/**
 * did the run that started this worker die? a SIGKILL of `site build` runs no cleanup, so the
 * worker keeps going against a dev server nobody will stop and spends the subscription on a
 * unit nobody will read. `runs/.lock` is the one thing the hooks can see the orchestrator
 * through: while it holds the pack the lock exists and names its pid. a lock that is not there,
 * or one this hook cannot read, says nothing either way, and the hook carries on.
 */
async function orphaned(pack: string): Promise<boolean> {
  try {
    const lock = await readJson(LockFileSchema, new PackPaths(pack).lock);
    return !processAlive(lock.pid);
  } catch {
    return false;
  }
}

/**
 * claude pipes the hook input on stdin. a failure here is reported as the hook's own decision,
 * never as a thrown zod dump: the reason travels to the worker as one line of text.
 */
async function hookInput(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('the hook input on stdin is not json');
  }
  const parsed = HookInputSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? issue.path.join('.') || '(root)' : '(unknown)';
    throw new Error(
      `the hook input on stdin is not a hook input: ${where}: ${issue?.message ?? 'invalid'}`,
    );
  }
  return parsed.data;
}

/** whatever the failure was, in one line: the worker reads it, and a dump would bury it */
function oneLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
}

function denyEdit(reason: string): void {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
}

export function registerHook(program: Command): void {
  const hook = program
    .command('hook')
    .description('the hooks a builder worker runs; claude calls them with json on stdin');
  hook
    .command('edit')
    .description('PreToolUse: deny an edit outside the allowed files, as a json decision on stdout')
    .requiredOption('--pack <dir>', 'pack directory', absoluteArg)
    .requiredOption(
      '--allowed <file>',
      'allowed-files.json: absolute files, and dirs ending in a slash',
      absoluteArg,
    )
    .action(async (o: { pack: string; allowed: string }) => {
      try {
        const input = await hookInput();
        if (input.hook_event_name !== 'PreToolUse') return;
        const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
        if (!file) return;
        // nothing this worker writes will be looked at, and its next stop releases it
        if (await orphaned(o.pack)) return denyEdit(ORPHANED);
        const allowed = await readJson(AllowedFilesSchema, o.allowed);
        if (editAllowed(file, input.cwd ?? process.cwd(), allowed)) return;
        denyEdit(`${file} is outside this unit's files. edit only: ${allowed.join(', ')}`);
      } catch (err) {
        // the hook protocol reads a non-zero exit as "carry on", so a hook that throws is a hook
        // that let the edit through. a failure this hook cannot explain is a denial it can.
        denyEdit(`site hook edit failed: ${oneLine(err)}`);
      }
    });
  hook
    .command('stop')
    .description(
      'Stop: rerun verify and hold the worker while it fails, up to --max-blocks times per round',
    )
    .requiredOption('--pack <dir>', 'pack directory', absoluteArg)
    .requiredOption('--unit <id>', 'unit id')
    .requiredOption('--target <url>', 'base url of the rebuild')
    .requiredOption('--out <dir>', "where this hook's verify runs write", absoluteArg)
    .requiredOption('--state <file>', 'stop-hook.json: how often this round was held', absoluteArg)
    .option(
      '--max-blocks <n>',
      'holds per round before the worker may stop',
      positiveIntArg,
      ORCHESTRATE.stopHookBlocks,
    )
    .option('--gate <fraction>', 'pixel mismatch gate', gateArg)
    .action(
      async (o: {
        pack: string;
        unit: string;
        target: string;
        out: string;
        state: string;
        maxBlocks: number;
        gate?: number;
      }) => {
        try {
          const input = await hookInput();
          if (input.hook_event_name !== 'Stop') return;
          // the run that started this worker was killed: let it stop now rather than hold it
          // through another verify against a dev server that is about to be nobody's
          if (await orphaned(o.pack)) return;
          let state: StopHookState;
          try {
            state = await readJson(StopHookStateSchema, o.state);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              state = { blocks: 0, lastVerdict: null };
            } else {
              // a state this hook cannot read is a state it cannot count holds in, and a hook
              // that throws here holds the worker for ever rather than not at all: read it as
              // a round that has held enough and let the worker stop, with the reason on
              // stderr where the round's log keeps it. the orchestrator's own verify decides
              process.stderr.write(
                `site hook stop: ${o.state} could not be read, so this worker is not held: ${oneLine(err)}\n`,
              );
              return;
            }
          }
          // held enough for this round: the worker may stop, and the orchestrator's own verify decides
          if (state.blocks >= o.maxBlocks) return;
          let reason: string;
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
            if (r.verdict === 'pass') {
              state.lastVerdict = 'pass';
              await writeJsonAtomic(o.state, state);
              return;
            }
            reason = `${summarise(r)}\nlook at: ${r.artefacts.join(', ')}`;
          } catch (err) {
            // a dev server that died is the worker's to notice; it costs a hold like a failure
            reason = `verify could not run: ${err instanceof Error ? err.message : String(err)}`;
          } finally {
            await session.close();
          }
          state.blocks += 1;
          state.lastVerdict = 'fail';
          await writeJsonAtomic(o.state, state);
          console.log(
            JSON.stringify({
              decision: 'block',
              reason: `verify failed (${state.blocks}/${o.maxBlocks}): ${reason}`,
            }),
          );
        } catch (err) {
          // exit 2 is the protocol's blocking error: the worker is held and this line reaches it.
          // any other exit would let it stop with the unit unverified and this hook none the wiser.
          process.stderr.write(`site hook stop failed: ${oneLine(err)}\n`);
          process.exitCode = 2;
        }
      },
    );
}
