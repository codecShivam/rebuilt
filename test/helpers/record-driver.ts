// a headless recording run through tsx, the path bin/site takes, so the injected recorder
// is exercised with esbuild's keepNames transform in place (vitest does not apply it).
// usage: node --import tsx test/helpers/record-driver.ts <start url> <pack root>
import { openSession } from '../../src/capture/session';
import { startRecording } from '../../src/capture/record';

const [start, root] = process.argv.slice(2);
if (!start || !root) throw new Error('usage: record-driver <start url> <pack root>');
const session = await openSession({});
try {
  const recording = await startRecording({ root, flow: 'driver', start, session });
  await recording.page.getByRole('button', { name: 'Talk to us' }).click();
  await recording.page.waitForTimeout(400);
  await recording.context.close();
  const file = await recording.done;
  console.log(JSON.stringify({ steps: file.steps.length, kinds: file.steps.map((s) => s.kind) }));
} finally {
  await session.close();
}
