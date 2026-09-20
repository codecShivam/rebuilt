import { ERROR_CODES } from './defaults';
import type { ViewportName } from './defaults';
import { safeUnitName } from './paths';
import type { Action, Manifest, UnitRecord } from './schemas';

/** what to do about each per-unit failure; the error's own message says what happened. */
export const HINTS: Record<string, string> = {
  [ERROR_CODES.blockedBySite]:
    'pass it by hand in a real chrome: start chrome with --remote-debugging-port=9222 on your own profile, pass the challenge there, then rerun capture with --attach http://127.0.0.1:9222; or rerun with --headed --profile and pass the challenge in the window it opens.',
  [ERROR_CODES.unreachable]:
    'check the trigger on the page and re-explore, or answer the input it needs.',
  [ERROR_CODES.needsInput]:
    'set the value under manifest.flows.<flow>.inputs, then rerun this unit.',
  [ERROR_CODES.httpError]:
    're-explore if the site moved the page, or drop this unit if the page is gone.',
  [ERROR_CODES.navigationFailed]:
    'check the url and the network, then re-explore, or drop this unit if the page is gone.',
  [ERROR_CODES.fontsMissing]:
    'the font responses were not saved: the server may deny them to a headless browser, or serve them with a type the store does not read as a font. rerun with --headed --profile, or with --attach on a chrome that loads them.',
  [ERROR_CODES.dependency]: 'fix the unit it depends on, then rerun build with --reopen for both.',
  [ERROR_CODES.roundsExhausted]:
    'read the artefacts, answer this question with what a worker should do differently (or set thresholdOverride with a thresholdReason on the unit), then rerun build with --reopen <unit>.',
};

export interface BlockInput {
  /** a value of ERROR_CODES, or an http code from the crawl */
  code: string;
  /** what happened; a leading `<unit id>: ` is stripped, a trailing period too */
  message: string;
  /** what to do; HINTS[code] when absent */
  hint?: string;
  /** absolute paths a reader needs; absent clears the previous list */
  artefacts?: string[];
}

/**
 * block a unit with a reason and a question a reader can act on. one helper for every caller
 * (capture, flows, explore, the orchestrator), so the per-unit status contract has one shape:
 * status `blocked`, `blockedReason` a code, `question` as `<id>: <why>. <hint>`, `artefacts`
 * when there are any, and the same question under `manifest.questions` (one open question
 * per unit; `site build` refuses to start while one is unanswered).
 */
export function blockUnit(
  manifest: Manifest,
  unitId: string,
  input: BlockInput,
  now: string = new Date().toISOString(),
): UnitRecord {
  const unit = manifest.units[unitId];
  if (!unit) throw new Error(`cannot block ${unitId}: not in the manifest`);
  const raw = input.message.trim();
  const why = (raw.startsWith(`${unitId}: `) ? raw.slice(unitId.length + 2) : raw).replace(
    /\.$/,
    '',
  );
  const hint = input.hint ?? HINTS[input.code] ?? '';
  unit.status = 'blocked';
  unit.blockedReason = input.code;
  unit.question = `${unitId}: ${why}. ${hint}`.trim();
  if (input.artefacts && input.artefacts.length) unit.artefacts = input.artefacts;
  else delete unit.artefacts;
  unit.updatedAt = now;
  const open = manifest.questions.find((q) => q.unit === unitId && q.answer === undefined);
  if (open) {
    open.text = unit.question;
  } else {
    const n = manifest.questions.filter((q) => q.unit === unitId).length + 1;
    manifest.questions.push({
      id: `q-${safeUnitName(unitId)}-${n}`,
      unit: unitId,
      text: unit.question,
    });
  }
  return unit;
}

/** the actions that reach a state at a viewport: its own pass's when the passes disagreed, the shared list otherwise */
export function actionsFor(unit: UnitRecord, viewport: ViewportName): Action[] {
  return unit.actionsByViewport?.[viewport] ?? unit.actions ?? [];
}
