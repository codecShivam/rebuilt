import { acquireLock, LockError } from '../orchestrate/lock';

/**
 * the pack lock around a command that writes the manifest. every writer rewrites the whole
 * file from its own in-memory copy (the capture layer's saveManifest, and the orchestrator's
 * store after each transition), so a capture run while a build is working the pack leaves
 * whichever side saved last: in-flight statuses flip, a recaptured page's new sections vanish,
 * a run's blocks and questions disappear. one orchestrator per pack was always the promise;
 * this makes it one writer.
 *
 * a pack somebody else holds is refused the way `site build` refuses it: the reason on stderr
 * and exit 1, with no stack, because a refusal is the tool's answer and not a crash.
 */
export async function withPackLock(
  root: string,
  command: string,
  fn: () => Promise<void>,
): Promise<void> {
  let release: () => Promise<void>;
  try {
    release = await acquireLock(root, command);
  } catch (err) {
    if (err instanceof LockError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  try {
    await fn();
  } finally {
    await release();
  }
}
