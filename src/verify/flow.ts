import type { Session } from '../capture/session';
import { loadManifest } from '../pack/io';
import type { VerifyResult } from '../pack/schemas';
import { verifyUnit } from './verify';

/** verifyUnit for every captured step of a flow, in order. */
export async function verifyFlow(opts: {
  root: string;
  flow: string;
  target: string;
  session: Session;
  gate?: number;
}): Promise<VerifyResult[]> {
  const manifest = await loadManifest(opts.root);
  const flow = manifest.flows[opts.flow];
  if (!flow || !flow.steps.length) {
    throw new Error(`flow "${opts.flow}" has no captured steps; run replay without --target first`);
  }
  const results: VerifyResult[] = [];
  for (const unitId of flow.steps) {
    results.push(
      await verifyUnit({
        root: opts.root,
        unitId,
        target: opts.target,
        session: opts.session,
        gate: opts.gate,
      }),
    );
  }
  return results;
}
