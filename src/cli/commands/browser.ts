import path from 'node:path';
import { InvalidArgumentError, type Command } from 'commander';
import { driverCall, keepBrowser, markFlow, markState } from '../../capture/driver';
import { closeBrowser, openBrowser } from '../../orchestrate/explorer';
import { siteBin } from '../../orchestrate/hooks';
import type { ViewportName } from '../../pack/defaults';
import type { DriverReply, Target } from '../../pack/schemas';
import { flowArg, positiveIntArg, viewportArg } from '../args';

interface SessionOption {
  session?: string;
}

interface TargetOptions extends SessionOption {
  role?: string;
  name?: string;
  text?: string;
  css?: string;
}

/**
 * the session dir: the orchestrator's through the environment, which a worker cannot redirect
 * (its allowlist is `Bash(site browser *)`, and a `--session` of its own is ignored); a
 * person's through --session.
 */
function sessionDir(o: SessionOption): string {
  const dir = process.env['SITE_BROWSER_SESSION'] ?? o.session;
  if (!dir) throw new InvalidArgumentError('pass --session <dir> or set SITE_BROWSER_SESSION');
  return path.resolve(dir);
}

/**
 * the process a session opened from here belongs to. `site browser open` is one shot: it exits
 * as soon as the browser is up, so it can never be the owner itself. an orchestrator that starts
 * a worker names itself in SITE_BROWSER_OWNER, the same way it names the session dir, because
 * the shell its worker runs the command in may not outlive the command; with no variable, the
 * process that ran this one is the owner, which is the shell a person typed it in.
 */
function ownerPid(): number {
  const named = Number(process.env['SITE_BROWSER_OWNER']);
  return Number.isInteger(named) && named > 0 ? named : process.ppid;
}

/** the target the way the recorder spells one: role and name first, text, then a css selector */
function targetOf(o: TargetOptions): Target {
  if ((o.role && !o.name) || (!o.role && o.name)) {
    throw new InvalidArgumentError('--role and --name go together');
  }
  if (!o.role && !o.text && !o.css) {
    throw new InvalidArgumentError(
      'name the element: --role <role> --name <name>, --text <text> or --css <selector>',
    );
  }
  return {
    role: o.role && o.name ? { role: o.role, name: o.name } : null,
    text: o.text ?? null,
    css: o.css ?? '',
  };
}

function print(reply: DriverReply): void {
  if (reply.note) console.log(`note: ${reply.note}`);
  if (reply.snapshot) console.log(reply.snapshot);
  if (reply.error) {
    console.error(reply.error);
    process.exitCode = 1;
  }
}

const SESSION = ['--session <dir>', 'the session dir (default: SITE_BROWSER_SESSION)'] as const;

function withTarget(cmd: Command): Command {
  return cmd
    .option('--role <role>', 'the role, with --name (button, link, textbox, ...)')
    .option('--name <name>', 'the accessible name, with --role')
    .option('--text <text>', 'the exact visible text')
    .option('--css <selector>', 'a css selector')
    .option(...SESSION);
}

export function registerBrowser(program: Command): void {
  const browser = program
    .command('browser')
    .description(
      'drive a browser one command at a time, the way an explorer worker does; the page lives in a keeper process between calls',
    );
  browser
    .command('open <url>')
    .description('open a page in a fresh browser (closing the one before) and print it')
    .option('--viewport <name>', 'mobile or desktop', viewportArg, 'desktop')
    .option(...SESSION)
    .action(async (url: string, o: SessionOption & { viewport: ViewportName }) => {
      const dir = sessionDir(o);
      // the keeper stops when its owner is gone (see ownerPid above); an orchestrator that
      // opens a session for itself calls openBrowser directly and is its own owner
      await openBrowser({
        site: siteBin(),
        sessionDir: dir,
        url,
        viewport: o.viewport,
        ownerPid: ownerPid(),
      });
      print(await driverCall(dir, { kind: 'snapshot' }));
    });
  browser
    .command('keep <url>', { hidden: true })
    .description('the keeper itself: started detached by open')
    .requiredOption('--session <dir>', 'the session dir')
    .requiredOption(
      '--owner-pid <pid>',
      'the process this session belongs to; the keeper stops when it is gone',
      positiveIntArg,
    )
    .option('--viewport <name>', 'mobile or desktop', viewportArg, 'desktop')
    // through the same lookup as every other command: the environment wins, so a worker that
    // runs this command itself lands on its own session, whose allow.json bounds where it goes
    .action(
      async (url: string, o: { session: string; viewport: ViewportName; ownerPid: number }) => {
        await keepBrowser({
          sessionDir: sessionDir(o),
          url,
          viewport: o.viewport,
          ownerPid: o.ownerPid,
        });
      },
    );
  browser
    .command('snapshot')
    .description('print the page as it is now')
    .option(...SESSION)
    .action(async (o: SessionOption) => {
      print(await driverCall(sessionDir(o), { kind: 'snapshot' }));
    });
  for (const kind of ['hover', 'click'] as const) {
    withTarget(
      browser.command(kind).description(`${kind} an element and print the page after`),
    ).action(async (o: TargetOptions) => {
      print(
        await driverCall(sessionDir(o), {
          kind: 'act',
          action: { kind, target: targetOf(o), value: null, input: null, scroll: null },
        }),
      );
    });
  }
  withTarget(
    browser
      .command('fill')
      .description(
        'type into a field and print the page after; a field for personal data or a payment is refused and recorded as an input to ask for',
      ),
  )
    .requiredOption('--value <text>', 'what to type')
    .action(async (o: TargetOptions & { value: string }) => {
      print(
        await driverCall(sessionDir(o), {
          kind: 'act',
          action: { kind: 'input', target: targetOf(o), value: o.value, input: null, scroll: null },
        }),
      );
    });
  browser
    .command('state <name>')
    .description(
      'mark the page as it is now, reached by everything since the last open, as a candidate state',
    )
    .option(...SESSION)
    .action(async (name: string, o: SessionOption) => {
      const s = await markState(sessionDir(o), name);
      console.log(
        `state ${s.name}: ${s.actions.length} action${s.actions.length === 1 ? '' : 's'} from ${s.url}`,
      );
    });
  browser
    .command('flow')
    .description('save everything since the last open as a candidate flow')
    .argument('<name>', 'flow name (lowercase letters, digits, hyphens)', flowArg)
    .option('--input <name...>', 'inputs the flow needs that a person has to supply')
    .option(...SESSION)
    .action(async (name: string, o: SessionOption & { input?: string[] }) => {
      const f = await markFlow(sessionDir(o), name, o.input ?? []);
      console.log(
        `flow ${f.name}: ${f.steps.length} step${f.steps.length === 1 ? '' : 's'} from ${f.start}${f.inputs.length ? `, inputs: ${f.inputs.join(', ')}` : ''}`,
      );
    });
  browser
    .command('close')
    .description('close the browser')
    .option(...SESSION)
    .action(async (o: SessionOption) => {
      console.log((await closeBrowser(sessionDir(o))) ? 'closed' : 'no browser was open');
    });
}
