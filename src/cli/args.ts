import path from 'node:path';
import { InvalidArgumentError } from 'commander';
import { VIEWPORT_NAMES, type ViewportName } from '../pack/defaults';
import { FLOW_NAME } from '../pack/ids';

/**
 * a path option, resolved against the cli's own cwd. the orchestrator hands these paths to
 * workers and hooks that run with the rebuilt project as their cwd, and writes them into the
 * manifest and the briefs, so a relative spelling would resolve somewhere else entirely by the
 * time it is read.
 */
export function absoluteArg(value: string): string {
  return path.resolve(value);
}

/**
 * `--claude`: a bare name stays a PATH lookup, a path is resolved here. the worker runs with
 * the project as its cwd, so `./bin/claude` would be looked for under the project and the round
 * would crash before it started.
 */
export function claudeArg(value: string): string {
  return value.includes('/') || value.includes(path.sep) ? path.resolve(value) : value;
}

/** a flow name becomes a dir, a file and a unit id segment: lowercase letters, digits, hyphens. */
export function flowArg(value: string): string {
  if (!FLOW_NAME.test(value)) {
    throw new InvalidArgumentError(
      `flow name must be lowercase letters, digits and hyphens, got "${value}"`,
    );
  }
  return value;
}

/** a mistyped gate must stop the run: `score > NaN` is false, so a typo would pass everything. */
export function gateArg(value: string): number {
  // whatever Number reads as a finite number of 0 or more is a gate, exponents included: the
  // hooks pass their gate as String(gate), and String(1e-7) is '1e-7'. Number('') and Number(' ')
  // are 0, which would gate nothing, so an empty value is a typo rather than the tightest gate.
  const n = value.trim() === '' ? NaN : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError('gate must be a number of 0 or more');
  }
  return n;
}

/** a count (`--rounds`, `--parallel`, `--max-blocks`): a whole number of 1 or more */
export function positiveIntArg(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new InvalidArgumentError('must be a whole number of 1 or more');
  }
  return Number(value);
}

/** `--viewport`: one of the two names a pack captures at */
export function viewportArg(value: string): ViewportName {
  if (!(VIEWPORT_NAMES as string[]).includes(value)) {
    throw new InvalidArgumentError(`viewport must be one of ${VIEWPORT_NAMES.join(', ')}`);
  }
  return value as ViewportName;
}
