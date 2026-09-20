import { Command } from 'commander';
import { pathToFileURL } from 'node:url';
import { TOOL_VERSION } from '../version';
import { registerExplore } from './commands/explore';
import { registerCapture } from './commands/capture';
import { registerVerify } from './commands/verify';
import { registerRecord } from './commands/record';
import { registerReplay } from './commands/replay';
import { registerHook } from './commands/hook';
import { registerScaffold } from './commands/scaffold';
import { registerPlan } from './commands/plan';
import { registerBuild } from './commands/build';
import { registerReport } from './commands/report';
import { registerShot } from './commands/shot';
import { registerBrowser } from './commands/browser';
import { registerBrand } from './commands/brand';

export const program = new Command()
  .name('site')
  .description('capture any website into a reference pack and verify a rebuild against it')
  .version(TOOL_VERSION);

registerExplore(program);
registerCapture(program);
registerVerify(program);
registerRecord(program);
registerReplay(program);
registerHook(program);
registerScaffold(program);
registerPlan(program);
registerBuild(program);
registerReport(program);
registerShot(program);
registerBrowser(program);
registerBrand(program);

// pathToFileURL, not a `file://` template: a path with a space or a non-ascii character
// would not compare equal to the encoded url node gives import.meta.url.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
