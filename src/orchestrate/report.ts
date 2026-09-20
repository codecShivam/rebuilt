import fs from 'node:fs/promises';
import { loadManifest, readJson } from '../pack/io';
import { PackPaths, RunPaths } from '../pack/paths';
import { RunLogSchema, type Manifest, type RunLog } from '../pack/schemas';
// what a run that was killed hard left behind: the next build restores these to captured
import { IN_FLIGHT } from './state';

function wall(startedAt: string, endedAt: string | null): string {
  const ms = (endedAt ? Date.parse(endedAt) : Date.now()) - Date.parse(startedAt);
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s${endedAt ? '' : ' (still running)'}`;
}

/** runs/<run>/report.md: passed, blocked with reasons, rounds per unit, waits, wall time */
export function reportText(manifest: Manifest, log: RunLog): string {
  const units = Object.entries(manifest.units);
  const passed = units.filter(([, u]) => u.status === 'passed');
  const blocked = units.filter(([, u]) => u.status === 'blocked');
  const inFlight = units.filter(([, u]) => IN_FLIGHT.includes(u.status));
  const todo = units.filter(
    ([, u]) => u.status !== 'passed' && u.status !== 'blocked' && !IN_FLIGHT.includes(u.status),
  );
  const last = new Map<string, RunLog['rounds'][number]>();
  for (const r of log.rounds) last.set(r.unitId, r);
  const waits = log.rounds.flatMap((r) => r.waits);
  const waited = waits.reduce((sum, w) => sum + w.ms, 0);
  const lines = [
    `# build ${log.run}`,
    '',
    `- pack: ${log.root}`,
    `- project: ${log.project}`,
    `- target: ${log.target}`,
    `- claude: ${log.claude}`,
    `- options: parallel ${log.options.parallel}, rounds ${log.options.rounds}, threshold ${log.options.threshold ?? 'default'}`,
    `- started: ${log.startedAt}`,
    `- wall time: ${wall(log.startedAt, log.endedAt)}`,
    `- rounds run: ${log.rounds.length}`,
    `- waited for rate limits ${waits.length} time${waits.length === 1 ? '' : 's'}, ${Math.round(waited / 1000)}s in total`,
  ];
  if (log.restored.length) lines.push(`- restored from a killed run: ${log.restored.join(', ')}`);
  if (log.models) {
    lines.push(
      `- models: builder ${log.models.builder ?? 'default'}, reviewer ${log.models.reviewer ?? 'default'}`,
    );
  }
  lines.push('', `## passed (${passed.length})`, '');
  for (const [id, u] of passed)
    lines.push(`- ${id} (${u.rounds} round${u.rounds === 1 ? '' : 's'})`);
  lines.push('', `## blocked (${blocked.length})`, '');
  for (const [id, u] of blocked) {
    lines.push(`- ${id}: ${u.blockedReason ?? '?'}`);
    if (u.question) lines.push(`  - ${u.question}`);
    for (const a of u.artefacts ?? []) lines.push(`  - ${a}`);
  }
  // a run that ended normally restores what it had in flight, so anything still here was left
  // by a kill this report is being written after
  lines.push('', `## interrupted (${inFlight.length})`, '');
  for (const [id, u] of inFlight) lines.push(`- ${id} (${u.status})`);
  // a unit whose dependency is blocked is never scheduled and never cascaded again, so "not
  // started" on its own would leave a reader with no reason; the blocked id is the reason
  const blockedIds = new Set(blocked.map(([id]) => id));
  lines.push('', `## not started (${todo.length})`, '');
  for (const [id, u] of todo) {
    const waitingOn = u.dependsOn.filter((d) => blockedIds.has(d));
    lines.push(
      `- ${id} (${u.status})${waitingOn.length ? `, waiting on ${waitingOn.join(', ')}` : ''}`,
    );
  }
  lines.push(
    '',
    '## rounds per unit',
    '',
    '| unit | rounds | last result | last reason |',
    '|---|---|---|---|',
  );
  for (const [id, u] of units) {
    const r = last.get(id);
    if (!r && !u.rounds) continue;
    // this run's own count: a unit reopened after a block carries rounds 0 into the run, and a
    // unit blocked by a cascade never ran at all
    lines.push(`| ${id} | ${r?.round ?? u.rounds} | ${r?.result ?? '-'} | ${r?.reason ?? '-'} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** the newest run dir under runs/ that has a run.json */
export async function latestRun(root: string): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(new PackPaths(root).runsDir);
  } catch {
    return null;
  }
  for (const name of names.sort().reverse()) {
    try {
      await fs.stat(new RunPaths(root, name).log);
      return name;
    } catch {
      /* not a run */
    }
  }
  return null;
}

export async function writeReport(root: string, run: string): Promise<string> {
  const paths = new RunPaths(root, run);
  const log = await readJson(RunLogSchema, paths.log);
  const manifest = await loadManifest(root);
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.report, reportText(manifest, log));
  return paths.report;
}
