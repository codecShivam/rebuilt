import path from 'node:path';
import { writeJson } from '../pack/io';
import { VERIFY_FILE } from '../pack/paths';
import { VerifyResultSchema, type VerifyResult } from '../pack/schemas';

export async function writeVerifyResult(outDir: string, result: VerifyResult): Promise<string> {
  VerifyResultSchema.parse(result);
  const file = path.join(outDir, VERIFY_FILE);
  await writeJson(file, result);
  return file;
}

export function summarise(r: VerifyResult): string {
  const lines = [`${r.unitId} vs ${r.target}: ${r.verdict.toUpperCase()} (gate ${r.gate})`];
  for (const vp of ['mobile', 'desktop'] as const) {
    const p = r.pixel[vp];
    if (p)
      lines.push(
        `  ${vp}: pixel ${(p.score * 100).toFixed(3)}% (${p.mismatched}/${p.total})  height delta ${r.heightDelta[vp]}px`,
      );
  }
  if (r.missing.length) lines.push(`  missing: ${r.missing.join(', ')}`);
  for (const s of r.styles.slice(0, 40))
    lines.push(
      `  style ${s.viewport} ${s.path} ${s.property}: expected ${s.expected}, got ${s.actual}`,
    );
  if (r.styles.length > 40) lines.push(`  ... ${r.styles.length - 40} more style findings`);
  for (const a of r.animations.slice(0, 40))
    lines.push(
      `  animation ${a.viewport} ${a.path} ${a.property}: expected ${a.expected}, got ${a.actual}`,
    );
  if (r.animations.length > 40)
    lines.push(`  ... ${r.animations.length - 40} more animation findings`);
  // the note is why nothing was compared: without it `0 compared` reads as a failure to look
  for (const f of r.frames)
    lines.push(
      `  frames ${f.viewport} ${f.segment}: ${f.compared} compared, mean ${(f.meanScore * 100).toFixed(2)}%, max ${(f.maxScore * 100).toFixed(2)}% at frame ${f.worstFrame}${f.note ? ` (${f.note})` : ''}`,
    );
  for (const f of r.structure)
    lines.push(`  structure ${f.kind} @ ${f.where}: expected ${f.expected}, got ${f.actual}`);
  return lines.join('\n');
}
