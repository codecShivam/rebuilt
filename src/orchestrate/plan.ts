import type { Manifest } from '../pack/schemas';
import { summary } from './state';

/** `site plan`: what the queue holds, what the flows need, what a person still has to answer */
export function planText(manifest: Manifest): string {
  const s = summary(manifest);
  const st = s.byStatus;
  const k = s.byKind;
  const lines = [
    `${manifest.host}: ${s.total} units`,
    `  by status: planned ${st.planned}, captured ${st.captured}, building ${st.building}, verifying ${st.verifying}, reviewing ${st.reviewing}, passed ${st.passed}, blocked ${st.blocked}`,
    `  by kind: ${k.page} pages, ${k.section} sections, ${k.state} states, ${k.flowStep} flow steps`,
    `  ready now: ${s.ready.length}${
      s.ready.length
        ? ` (${s.ready.slice(0, 8).join(', ')}${s.ready.length > 8 ? ', ...' : ''})`
        : ''
    }`,
  ];
  if (s.inFlight.length) {
    lines.push(
      `  in flight (a killed run; the next build restores them): ${s.inFlight.join(', ')}`,
    );
  }
  lines.push('flows:');
  if (!s.flows.length) lines.push('  none');
  for (const f of s.flows) {
    const inputs = Object.entries(f.inputs)
      .map(([n, v]) => `${n}${v === null ? ' (unset)' : ''}`)
      .join(', ');
    lines.push(
      `  ${f.name}: ${f.steps} step${f.steps === 1 ? '' : 's'}, inputs: ${inputs || 'none'}`,
    );
  }
  if (s.blocked.length) {
    lines.push('blocked:');
    for (const b of s.blocked) lines.push(`  ${b.id}: ${b.reason}`);
  }
  const open = s.questions.open;
  lines.push(
    `${open.length} open question${open.length === 1 ? '' : 's'}${
      s.questions.answered ? ` (${s.questions.answered} answered)` : ''
    }:`,
  );
  for (const q of open) lines.push(`  [${q.id}] ${q.text}`);
  if (open.length) {
    lines.push(
      '  site build refuses to start while one is open: answer it in manifest.json (questions[].answer), set the flow input it names, or rerun build with --reopen <unit> once the unit is fixed',
    );
  }
  return lines.join('\n');
}
