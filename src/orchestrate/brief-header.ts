import { WorkerRoleSchema, type WorkerRole } from '../pack/schemas';

/**
 * the header line every brief carries, on its own so that reading one costs nothing: the fake
 * claude parses it on every call and would otherwise load the whole brief module's graph.
 * src/orchestrate/brief.ts re-exports both helpers, so importing them from there still works.
 */

/** the first line of every brief: how the fake claude and the logs know which call this is. */
export function briefHeader(role: WorkerRole, unitId: string, round: number): string {
  return `<!-- site role=${role} unit=${unitId} round=${round} -->`;
}

// the roles come from the schema: a role added there is parsed here without a second edit
const HEADER = new RegExp(
  `<!-- site role=(${WorkerRoleSchema.options.join('|')}) unit=(\\S+) round=(\\d+) -->`,
);

export function parseBriefHeader(
  text: string,
): { role: WorkerRole; unit: string; round: number } | null {
  const m = HEADER.exec(text);
  return m ? { role: m[1] as WorkerRole, unit: m[2]!, round: Number(m[3]) } : null;
}
