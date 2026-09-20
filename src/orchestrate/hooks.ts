import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson } from '../pack/io';
import { HookSettingsSchema, type HookSettings } from '../pack/schemas';

export interface HookSettingsInput {
  /** the site binary the hooks call: this checkout's bin/site */
  site: string;
  pack: string;
  unitId: string;
  target: string;
  /** round-N/allowed-files.json */
  allowedFile: string;
  /** round-N/stop-hook.json */
  stopStateFile: string;
  /** where the stop hook's own verify runs write (not the orchestrator's verify dir) */
  verifyOutDir: string;
  /** holds per round before the worker may stop; the orchestrator's verify decides after that */
  maxBlocks: number;
  gate?: number;
}

/**
 * single quotes around one argument of a hook command. the command is a plain command line that
 * claude's own shell parses, not an `sh -c` this code writes, but it is still a shell that
 * splits on spaces, so a path with a space or a quote needs them to arrive as one argument.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** this checkout's bin/site, from this file's location, so the hooks call the same code whatever the cwd. */
export function siteBin(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'site');
}

/**
 * the settings file a builder gets with --settings: a PreToolUse hook on every edit tool that
 * denies a path outside the unit's files, and a Stop hook that reruns verify and holds the
 * worker while it fails. both are given the pack, because both read `runs/.lock` to see whether
 * the orchestrator that started this worker is still alive. the shape is the hooks reference's;
 * `timeout` is seconds.
 */
export function hookSettings(i: HookSettingsInput): HookSettings {
  const q = shellQuote;
  const edit = `${q(i.site)} hook edit --pack ${q(i.pack)} --allowed ${q(i.allowedFile)}`;
  const stop = [
    q(i.site),
    'hook',
    'stop',
    '--pack',
    q(i.pack),
    '--unit',
    q(i.unitId),
    '--target',
    q(i.target),
    '--out',
    q(i.verifyOutDir),
    '--state',
    q(i.stopStateFile),
    '--max-blocks',
    String(i.maxBlocks),
    ...(i.gate !== undefined ? ['--gate', String(i.gate)] : []),
  ].join(' ');
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Edit|Write|MultiEdit|NotebookEdit',
          hooks: [{ type: 'command', command: edit, timeout: 30 }],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: stop, timeout: 600 }] }],
    },
  };
}

export async function writeHookSettings(file: string, i: HookSettingsInput): Promise<HookSettings> {
  const settings = HookSettingsSchema.parse(hookSettings(i));
  await writeJson(file, settings);
  return settings;
}

/**
 * a path realpathAhead cannot say the opening place of: a symlink that dangles or loops, or a
 * component the process may not read. every caller turns it into a denial, because a path
 * nobody can name is a path nobody can judge.
 */
export class UnresolvedPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnresolvedPathError';
  }
}

/** a name that is there in its parent dir, whatever it resolves to (a dangling link is) */
function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * the path as the filesystem would open it: the longest ancestor that exists is resolved
 * through its symlinks and the rest of the path (the part that is not there yet) is put back
 * on. a Write creates its target, so the target itself need not exist; a symlink under an
 * allowed dir would otherwise let the write land anywhere.
 *
 * only a plain missing name walks up to its parent. a name that is there but does not resolve
 * is not a missing name, and the difference is the whole point: a dangling symlink
 * (`src/esc -> ../../outside/x.tsx`, target not created yet) fails realpath with ENOENT exactly
 * as a missing file does, yet the write follows it out of the project. so a failure is checked
 * with lstat, and a symlink that dangles or loops throws rather than being put back on
 * textually. anything the errno cannot explain as absence (ENOENT, ENOTDIR) throws too: an
 * unreadable ancestor hides where the rest of the path leads, and guessing is what opens a hole.
 */
export function realpathAhead(abs: string): string {
  let existing = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(existing);
      return rest.length ? path.join(real, ...rest) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (isLink(existing)) {
        throw new UnresolvedPathError(`${abs}: ${existing} is a symlink that does not resolve`);
      }
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new UnresolvedPathError(`${abs}: ${existing} cannot be resolved (${code})`);
      }
    }
    const parent = path.dirname(existing);
    // the root itself did not resolve: there is no ancestor left to name the path from
    if (parent === existing) throw new UnresolvedPathError(`${abs}: no ancestor resolves`);
    rest.unshift(path.basename(existing));
    existing = parent;
  }
}

/**
 * an edit is allowed when its path is one of the listed files, or lies under one of the
 * listed dirs (entries ending in a slash). the target is resolved against the hook's cwd and
 * through realpathAhead, so a symlink on the way is judged by where it points and a path that
 * cannot be resolved at all is refused; a sibling that merely shares a prefix (`a.tsx.bak`,
 * `index2/`) is outside.
 *
 * that puts a contract on the caller: `allowed` and `cwd` must be built from the same resolved
 * project root (the orchestrator realpaths the project once and derives both from it). the
 * entries themselves are compared as given, so two spellings of one path never match, and the
 * failure is a denial of every edit rather than a hole.
 */
export function editAllowed(file: string, cwd: string, allowed: string[]): boolean {
  let abs: string;
  try {
    abs = realpathAhead(path.resolve(cwd, file));
  } catch {
    // UnresolvedPathError, or anything else that could go wrong naming the path: a target this
    // cannot place is a target this cannot clear, and the gate's safe direction is a denial
    return false;
  }
  return allowed.some((entry) => {
    const dir = entry.endsWith('/') || entry.endsWith(path.sep);
    const e = path.resolve(cwd, entry);
    return dir ? abs === e || abs.startsWith(e + path.sep) : abs === e;
  });
}

/**
 * the environment a worker or a keeper gets: this checkout's bin/ first on PATH, so `site`
 * resolves by name inside a worker's shell, over the caller's variables over this process's.
 * an unset PATH becomes the bin dir alone rather than `bin:`, whose empty element posix reads
 * as the current directory.
 *
 * this only ever prefixes PATH and never takes a variable away, so it composes one way round:
 * `workerEnv(siteEnv(site, env))`. worker.ts strips the session variables, and stripping has to
 * come last or the variables this adds back would survive it.
 */
export function siteEnv(site: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = { ...process.env, ...env };
  const dir = path.dirname(site);
  const rest = base['PATH'];
  return { ...base, PATH: rest ? `${dir}${path.delimiter}${rest}` : dir };
}
