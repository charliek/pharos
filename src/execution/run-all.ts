import type { PharosConfig } from '../config/config';
import { assertConfigForModes } from '../config/validate';
import { ContractRegistry } from '../contract/load';
import { ValidationError } from '../errors';
import { discoverScenarioFiles, matchesFilter, type ScenarioFilter } from '../scenarios/discover';
import { loadScenarioFile } from '../scenarios/load';
import type { Scenario, ScenarioMode } from '../scenarios/schema';
import { loadHookRegistry } from './hooks';
import { runScenario, type ScenarioResult } from './runner';

/**
 * Project-level execution: discover scenarios, filter, fail fast on missing
 * config for the selected modes, then run each. Shared by the `run` and `record`
 * CLI commands. Hook and contract registries are loaded once per project run.
 */

export interface RunProjectOptions extends ScenarioFilter {
  recordingEnabled?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Restrict to these modes (e.g. record uses ['legacy_record']). */
  modes?: ScenarioMode[];
}

function loadFailureResult(file: string, error: unknown): ScenarioResult {
  const detail =
    error instanceof ValidationError
      ? error.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    scenarioId: file,
    name: file,
    pass: false,
    skipped: false,
    steps: [],
    error: detail,
    durationMs: 0,
  };
}

export async function runProject(
  config: PharosConfig,
  options: RunProjectOptions = {},
): Promise<ScenarioResult[]> {
  const hookRegistry = await loadHookRegistry(config.hooks_module);
  const contractRegistry = new ContractRegistry();

  const selected: Array<{ file: string; scenario: Scenario }> = [];
  const loadFailures: ScenarioResult[] = [];
  for (const file of discoverScenarioFiles(config.scenario_dir)) {
    let scenario: Scenario;
    try {
      scenario = loadScenarioFile(file);
    } catch (error) {
      loadFailures.push(loadFailureResult(file, error));
      continue;
    }
    if (options.modes && !options.modes.includes(scenario.mode)) continue;
    if (!matchesFilter(scenario, options)) continue;
    selected.push({ file, scenario });
  }

  // Fail fast if required base URLs are missing for the selected modes.
  assertConfigForModes(config, new Set(selected.map((entry) => entry.scenario.mode)));

  const results: ScenarioResult[] = [...loadFailures];
  for (const { file, scenario } of selected) {
    results.push(
      await runScenario(scenario, file, config, contractRegistry, {
        hooks: hookRegistry.hooks,
        comparators: hookRegistry.comparators,
        recordingEnabled: options.recordingEnabled,
        env: options.env,
      }),
    );
  }
  return results;
}
