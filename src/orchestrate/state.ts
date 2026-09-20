import { ERROR_CODES } from '../pack/defaults';
import { parseUnitId } from '../pack/ids';
import type { Manifest, UnitRecord, UnitStatus } from '../pack/schemas';
import { blockUnit } from '../pack/units';
import { isChromeSection } from './layout';

type UnitKind = UnitRecord['kind'];
type Question = Manifest['questions'][number];

/** everything that may change a unit's status. the orchestrator emits these and nothing else writes a status. */
export type Event =
  | { type: 'build_started' }
  | { type: 'build_failed'; reason: string }
  | { type: 'verify_started' }
  | { type: 'verify_passed'; score: number | null }
  | { type: 'verify_failed'; score: number | null }
  | { type: 'review_passed' }
  | { type: 'review_rejected' }
  | { type: 'review_failed'; reason: string }
  | { type: 'blocked'; code: string; message: string; hint?: string; artefacts?: string[] }
  | { type: 'rate_limited' }
  | { type: 'interrupted' }
  | { type: 'reopened' };

export class IllegalTransition extends Error {
  constructor(
    readonly unitId: string,
    readonly status: UnitStatus,
    readonly event: Event['type'],
  ) {
    super(`${unitId}: ${event} is not legal from ${status}`);
    this.name = 'IllegalTransition';
  }
}

/** per event: the statuses it is legal from, and the status it writes (`same` keeps it). */
const LEGAL: Record<Event['type'], { from: UnitStatus[]; to: UnitStatus | 'same' }> = {
  build_started: { from: ['captured'], to: 'building' },
  build_failed: { from: ['building'], to: 'captured' },
  verify_started: { from: ['building'], to: 'verifying' },
  verify_passed: { from: ['verifying'], to: 'reviewing' },
  verify_failed: { from: ['verifying'], to: 'captured' },
  review_passed: { from: ['reviewing'], to: 'passed' },
  review_rejected: { from: ['reviewing'], to: 'captured' },
  /** the reviewer process failed (crashed, malformed, out of turns): a failed round, not a verdict */
  review_failed: { from: ['reviewing'], to: 'captured' },
  /** blocked is in the `from` list: a cascade may reach the same unit twice, and blockUnit
   * updates the unit's open question in place rather than adding a second one */
  blocked: {
    from: ['planned', 'captured', 'building', 'verifying', 'reviewing', 'blocked'],
    to: 'blocked',
  },
  rate_limited: { from: ['building', 'reviewing'], to: 'same' },
  interrupted: { from: ['building', 'verifying', 'reviewing'], to: 'captured' },
  reopened: { from: ['blocked'], to: 'captured' },
};

/** the statuses a run has a worker on; a killed run leaves them behind for the next restore. */
export const IN_FLIGHT: UnitStatus[] = ['building', 'verifying', 'reviewing'];

/**
 * blocks the capture layer raised. such a unit has no capture on disk (and a `planned`
 * dependent a cascade blocked never had one either), so reopening it into `captured` would
 * send the next builder brief looking for unit files that are not there and abort the run.
 */
const CAPTURE_SIDE_CODES: readonly string[] = [
  ERROR_CODES.blockedBySite,
  ERROR_CODES.unreachable,
  ERROR_CODES.navigationFailed,
  ERROR_CODES.httpError,
  ERROR_CODES.fontsMissing,
  ERROR_CODES.needsInput,
];

/**
 * apply one event to one unit, in place. `build_started` spends a round; `interrupted` gives
 * it back (a killed round is not a failed round); `blocked` goes through blockUnit so the
 * question shape is the one every caller writes; `reopened` clears the block, resets the
 * rounds and marks the unit's open questions answered, because the person who reopens has
 * read them, and lands on `planned` when the block came from capture.
 */
export function transition(
  manifest: Manifest,
  unitId: string,
  event: Event,
  now: string = new Date().toISOString(),
): UnitRecord {
  const unit = manifest.units[unitId];
  if (!unit) throw new Error(`${unitId} is not in the manifest`);
  const rule = LEGAL[event.type];
  if (!rule.from.includes(unit.status))
    throw new IllegalTransition(unitId, unit.status, event.type);
  let to: UnitStatus | 'same' = rule.to;
  switch (event.type) {
    case 'build_started':
      unit.rounds += 1;
      break;
    case 'verify_passed':
    case 'verify_failed':
      // a round with no score (nothing comparable) clears the last one: a stale number read as
      // this round's is worse than no number
      if (event.score === null) delete unit.lastScore;
      else unit.lastScore = event.score;
      break;
    case 'blocked':
      return blockUnit(
        manifest,
        unitId,
        { code: event.code, message: event.message, hint: event.hint, artefacts: event.artefacts },
        now,
      );
    case 'interrupted':
      unit.rounds = Math.max(0, unit.rounds - 1);
      break;
    case 'reopened':
      unit.rounds = 0;
      if (CAPTURE_SIDE_CODES.includes(unit.blockedReason ?? '')) to = 'planned';
      delete unit.blockedReason;
      delete unit.question;
      delete unit.artefacts;
      delete unit.lastRoundDir;
      for (const q of manifest.questions) {
        if (q.unit === unitId && q.answer === undefined) {
          q.answer = 'reopened';
          q.answeredAt = now;
        }
      }
      break;
    default:
      break;
  }
  if (to !== 'same') unit.status = to;
  unit.updatedAt = now;
  return unit;
}

/**
 * the page a unit's files belong to: its own (a state and a section are the page's), or its
 * flow. every unit has this one; a chrome section has `chrome` as well (see scopesOf).
 */
export function scopeOf(unitId: string): string {
  const p = parseUnitId(unitId);
  return p.kind === 'flowStep' ? `flow:${p.flow}` : `page:${p.slug}`;
}

/**
 * every set of files a unit's worker shares with somebody else. a unit is not one scope but a
 * set of them: its page always, because two sections of one page share its feature dir and its
 * route, and `chrome` as well for a header, nav or footer, because every page's is built from
 * one shared layout. a unit may start only when none of its scopes is in flight, so two
 * sections of one page never run together and neither do two pages' headers.
 */
export function scopesOf(manifest: Manifest, unitId: string): string[] {
  return isChromeSection(unitId) ? [scopeOf(unitId), 'chrome'] : [scopeOf(unitId)];
}

/** sections before pages before states before flow steps, then by id: the order the queue is worked in. */
const KIND_ORDER: Record<UnitKind, number> = { section: 0, page: 1, state: 2, flowStep: 3 };

function ready(manifest: Manifest): string[] {
  return Object.entries(manifest.units)
    .filter(
      ([, u]) =>
        u.status === 'captured' && u.dependsOn.every((d) => manifest.units[d]?.status === 'passed'),
    )
    .sort(
      ([a, ua], [b, ub]) =>
        KIND_ORDER[ua.kind] - KIND_ORDER[ub.kind] || (a < b ? -1 : a > b ? 1 : 0),
    )
    .map(([id]) => id);
}

/**
 * the units to start now: ready (captured, every dependency passed), in dependency order, none
 * of whose scopes is already in flight, and no more than the slots left once the units in
 * flight are counted. a scope is in flight when any in-flight unit carries it, so one page
 * never has two workers and neither does the shared chrome.
 */
export function nextUnits(manifest: Manifest, opts: { parallel: number }): string[] {
  const busy = new Set<string>();
  let working = 0;
  for (const [id, u] of Object.entries(manifest.units)) {
    if (!IN_FLIGHT.includes(u.status)) continue;
    working += 1;
    for (const scope of scopesOf(manifest, id)) busy.add(scope);
  }
  // the slots are units, not scopes: a chrome section takes two scopes and one worker
  const slots = opts.parallel - working;
  if (slots <= 0) return [];
  const picked: string[] = [];
  for (const id of ready(manifest)) {
    const scopes = scopesOf(manifest, id);
    if (scopes.some((scope) => busy.has(scope))) continue;
    for (const scope of scopes) busy.add(scope);
    picked.push(id);
    if (picked.length === slots) break;
  }
  return picked;
}

/** every unit that depends on this one, transitively, in manifest order. */
export function dependentsOf(manifest: Manifest, unitId: string): string[] {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, u] of Object.entries(manifest.units)) {
      if (out.has(id)) continue;
      if (u.dependsOn.some((d) => d === unitId || out.has(d))) {
        out.add(id);
        grew = true;
      }
    }
  }
  return [...out];
}

const INPUT_QUESTION = /^flow:([a-z0-9-]+):input:(.+)$/;

/** questions with no answer; a recorded input question counts as answered once the input is set. */
export function openQuestions(manifest: Manifest): Question[] {
  return manifest.questions.filter((q) => {
    if (q.answer !== undefined) return false;
    const m = INPUT_QUESTION.exec(q.id);
    if (!m) return true;
    const value = manifest.flows[m[1]!]?.inputs[m[2]!];
    return value === null || value === undefined;
  });
}

/** at the start of a run: whatever a killed run left in flight goes back to captured. returns the ids, sorted. */
export function restore(manifest: Manifest, now: string = new Date().toISOString()): string[] {
  const ids = Object.entries(manifest.units)
    .filter(([, u]) => IN_FLIGHT.includes(u.status))
    .map(([id]) => id)
    .sort();
  for (const id of ids) transition(manifest, id, { type: 'interrupted' }, now);
  return ids;
}

export interface Summary {
  total: number;
  byStatus: Record<UnitStatus, number>;
  byKind: Record<UnitKind, number>;
  /** captured with every dependency passed, in queue order, scopes ignored */
  ready: string[];
  inFlight: string[];
  blocked: { id: string; reason: string; question: string }[];
  flows: { name: string; steps: number; inputs: Record<string, string | null> }[];
  questions: { open: Question[]; answered: number };
}

export function summary(manifest: Manifest): Summary {
  const byStatus: Record<UnitStatus, number> = {
    planned: 0,
    captured: 0,
    building: 0,
    verifying: 0,
    reviewing: 0,
    passed: 0,
    blocked: 0,
  };
  const byKind: Record<UnitKind, number> = { page: 0, section: 0, state: 0, flowStep: 0 };
  const blocked: Summary['blocked'] = [];
  const inFlight: string[] = [];
  for (const [id, u] of Object.entries(manifest.units)) {
    byStatus[u.status] += 1;
    byKind[u.kind] += 1;
    if (IN_FLIGHT.includes(u.status)) inFlight.push(id);
    if (u.status === 'blocked') {
      blocked.push({ id, reason: u.blockedReason ?? '', question: u.question ?? '' });
    }
  }
  const open = openQuestions(manifest);
  return {
    total: Object.keys(manifest.units).length,
    byStatus,
    byKind,
    ready: ready(manifest),
    inFlight,
    blocked,
    flows: Object.entries(manifest.flows).map(([name, f]) => ({
      name,
      steps: f.steps.length,
      inputs: f.inputs,
    })),
    questions: { open, answered: manifest.questions.length - open.length },
  };
}
