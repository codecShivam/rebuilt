import fs from 'node:fs/promises';
import path from 'node:path';
import { readJson, writeJson } from '../../src/pack/io';
import {
  ScenarioSchema,
  ScenarioStateSchema,
  type Scenario,
  type ScenarioState,
} from '../../src/pack/schemas';
import { CLAUDE_SESSION_ENV, stripClaudeEnv } from '../../src/orchestrate/worker';

/** the launcher the tests hand to the runner as `claude`, or put first on PATH */
export const FAKE_CLAUDE_DIR = path.join(import.meta.dirname, 'fake-claude');
export const FAKE_CLAUDE = path.join(FAKE_CLAUDE_DIR, 'claude');

/**
 * a child's environment: this node first on PATH (the launcher and bin/site run `node`), the
 * fake's dir next when `claude` has to resolve by name, and the scenario named. never installed
 * anywhere: the variable and the PATH entry live for the child only. the session variables are
 * taken out here as well as in the runner, so a test that spawns the fake or bin/site itself
 * passes whether the suite runs from a terminal or from inside a claude code session.
 */
export function childEnv(scenario: string, onPath = false): NodeJS.ProcessEnv {
  const dirs = [
    path.dirname(process.execPath),
    ...(onPath ? [FAKE_CLAUDE_DIR] : []),
    process.env['PATH'] ?? '',
  ];
  const env = stripClaudeEnv({
    ...process.env,
    PATH: dirs.join(path.delimiter),
    SITE_FAKE_SCENARIO: scenario,
  });
  // leaving a variable out is not enough: execa extends process.env by default, so it would come
  // straight back from this process. node drops a variable whose value is undefined when it
  // builds the child's environment, and that is what keeps a session variable out either way
  for (const name of Object.keys(process.env)) {
    if (CLAUDE_SESSION_ENV.test(name)) env[name] = undefined;
  }
  return env;
}

/** write a scenario and forget any state a previous run of it left */
export async function writeScenario(file: string, scenario: Scenario): Promise<string> {
  ScenarioSchema.parse(scenario);
  await writeJson(file, scenario);
  await fs.rm(`${file}.state.json`, { force: true });
  return file;
}

export async function readScenarioState(file: string): Promise<ScenarioState> {
  return readJson(ScenarioStateSchema, `${file}.state.json`);
}

/** a builder that claims success and touched nothing; the gate tests lean on the claim being worthless */
export const DONE = { summary: 'built the section', filesTouched: [], notes: '' };
/** a reviewer that passes */
export const PASS = { verdict: 'pass', reasons: [] };
