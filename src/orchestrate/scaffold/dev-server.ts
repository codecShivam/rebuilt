import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { execa } from 'execa';
import { DEV_SERVER_FILES } from '../../pack/paths';
import { ORCHESTRATE } from '../defaults';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** playwright's readiness rule: up when 200 <= status < 404, a redirect followed. */
export async function isUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5_000) });
    return res.status >= 200 && res.status < 404;
  } catch {
    return false;
  }
}

export async function waitForServer(
  url: string,
  opts: { timeoutMs: number; pollMs: number; signal?: AbortSignal },
): Promise<void> {
  const until = Date.now() + opts.timeoutMs;
  while (Date.now() < until) {
    if (opts.signal?.aborted) throw new Error('aborted while waiting for the dev server');
    if (await isUp(url)) return;
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
  throw new Error(`${url} did not answer within ${opts.timeoutMs} ms`);
}

export interface DevServer {
  url: string;
  port: number;
  log: string;
  stop(): Promise<void>;
}

/**
 * the port a caller named was taken. next 14 does not exit on a busy port: it logs
 * `Port N is in use, trying N+1 instead` and serves on the next one, so a url built from the
 * requested port would answer from a foreign server. both the check before the spawn and the
 * one over the log after it raise this.
 */
export class PortInUseError extends Error {
  constructor(
    readonly port: number,
    readonly project: string,
    detail: string,
  ) {
    super(`port ${port} is in use, so the dev server in ${project} ${detail}`);
    this.name = 'PortInUseError';
  }
}

/** bind the port and let it go again: a port a caller named must be free before the spawn */
async function claimPort(port: number, project: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', (err: NodeJS.ErrnoException) => {
      reject(
        err.code === 'EADDRINUSE' ? new PortInUseError(port, project, 'was not started') : err,
      );
    });
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

/**
 * `npm run dev -- -p <port> -H 127.0.0.1` in the project, its output in a log file,
 * health-checked before it is returned. npm spawns next as a child, so the process group is
 * what stop() signals: SIGTERM, then SIGKILL after the grace period. the pid goes in a file
 * beside the log and comes off again in stop(): the server is detached and survives a hard
 * kill of its parent, so the next build is what signals the group a dead run left behind.
 */
export async function startDevServer(opts: {
  project: string;
  log: string;
  port?: number;
  timeoutMs?: number;
  pollMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<DevServer> {
  const port = opts.port ?? (await freePort());
  // freePort has just proved its own port free; a port the caller chose has not been checked
  if (opts.port !== undefined) await claimPort(opts.port, opts.project);
  const url = `http://127.0.0.1:${port}`;
  await fs.mkdir(path.dirname(opts.log), { recursive: true });
  // stdout and stderr each open the log themselves, so both append and the truncation
  // happens once, here; two truncating writers would overwrite each other's lines
  await fs.writeFile(opts.log, '');
  const child = execa('npm', ['run', 'dev', '--', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: opts.project,
    env: opts.env,
    extendEnv: true,
    detached: true,
    cleanup: false,
    reject: false,
    stdout: { file: opts.log, append: true },
    stderr: { file: opts.log, append: true },
  });
  const pidFile = path.join(path.dirname(opts.log), DEV_SERVER_FILES.pid);
  if (child.pid !== undefined) await fs.writeFile(pidFile, `${child.pid}\n`);
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const pid = child.pid;
    const signal = (s: NodeJS.Signals) => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, s);
      } catch {
        /* the group is gone already */
      }
    };
    signal('SIGTERM');
    const exited = await Promise.race([
      child.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), ORCHESTRATE.devServer.stopGraceMs)),
    ]);
    if (!exited) {
      signal('SIGKILL');
      await child;
    }
    // the file says "a dev server this run started is still up"; it is not, now
    await fs.rm(pidFile, { force: true });
  };
  // a server that exits before it answers (a dev script naming a binary that is not installed,
  // a project with no node_modules) must not be waited for. execa with `reject: false` resolves
  // even when the spawn itself failed, and then there is no code and no signal, only its message.
  const exited = child.then((r) => {
    throw new Error(`npm run dev exited with ${r.exitCode ?? r.signal ?? r.shortMessage}`);
  });
  try {
    await Promise.race([
      waitForServer(`${url}/`, {
        timeoutMs: opts.timeoutMs ?? ORCHESTRATE.devServer.timeoutMs,
        pollMs: opts.pollMs ?? ORCHESTRATE.devServer.pollMs,
        signal: opts.signal,
      }),
      exited,
    ]);
    // something answered on the port, but next says in the log that it is not the one it wanted
    if ((await fs.readFile(opts.log, 'utf8')).includes('is in use, trying')) {
      throw new PortInUseError(port, opts.project, `moved to another port; see ${opts.log}`);
    }
  } catch (err) {
    await stop();
    if (err instanceof PortInUseError) throw err;
    throw new Error(
      `dev server in ${opts.project}: ${err instanceof Error ? err.message : String(err)}; see ${opts.log}`,
    );
  }
  return { url, port, log: opts.log, stop };
}
