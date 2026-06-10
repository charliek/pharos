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

/**
 * Why a scenario should be skipped by a safety gate (spec Section 12), or
 * undefined to run it. Destructive scenarios need explicit opt-in; environment
 * restrictions are honored against the configured output mode.
 */
function scenarioSkipReason(scenario: Scenario, config: PharosConfig): string | undefined {
  const destructive =
    scenario.safety?.destructive === true || scenario.tags.includes('destructive');
  if (destructive && !config.allow_destructive_tests) {
    return 'destructive scenario requires ALLOW_DESTRUCTIVE_TESTS=true';
  }
  if (
    scenario.safety?.requiresProductionGuardOverride === true &&
    !config.allow_production_guard_override
  ) {
    return 'requires the production guard override (set ALLOW_PRODUCTION_GUARD_OVERRIDE=true)';
  }
  const allowed = scenario.safety?.allowedEnvironments;
  if (allowed && !allowed.includes(config.output_mode)) {
    return `not allowed in the '${config.output_mode}' environment`;
  }
  return undefined;
}

function skippedResult(scenario: Scenario, reason: string): ScenarioResult {
  return {
    scenarioId: scenario.id,
    name: scenario.name,
    pass: true,
    skipped: true,
    skipReason: reason,
    steps: [],
    durationMs: 0,
  };
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

  // Apply safety gates before requiring config: a skipped scenario imposes no
  // base-URL requirement because it never runs.
  const toRun: Array<{ file: string; scenario: Scenario }> = [];
  const skips: ScenarioResult[] = [];
  for (const entry of selected) {
    const reason = scenarioSkipReason(entry.scenario, config);
    if (reason) skips.push(skippedResult(entry.scenario, reason));
    else toRun.push(entry);
  }

  // Fail fast if required base URLs are missing for the modes that will run.
  assertConfigForModes(config, new Set(toRun.map((entry) => entry.scenario.mode)));

  const results: ScenarioResult[] = [...loadFailures, ...skips];
  for (const { file, scenario } of toRun) {
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
