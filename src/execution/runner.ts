import { performance } from 'node:perf_hooks';
import type { CustomComparator } from '../comparison/compare';
import type { ComparisonRules } from '../comparison/rules';
import type { PharosConfig } from '../config/config';
import type { ContractRegistry } from '../contract/load';
import { resolveScenarioContractRules } from '../contract/resolve';
import type { Scenario } from '../scenarios/schema';
import { sendRequest } from './http-client';
import { runStep, type SendFn, type StepResult } from './step-runner';
import type { VariableContext } from './variables';

export interface ScenarioResult {
  scenarioId: string;
  name: string;
  pass: boolean;
  skipped: boolean;
  steps: StepResult[];
  /** Scenario-level error (e.g. contract resolution) that prevented execution. */
  error?: string;
  durationMs: number;
}

export interface RunnerDeps {
  send?: SendFn;
  env?: NodeJS.ProcessEnv;
  comparators?: Record<string, CustomComparator>;
}

/**
 * Orchestrate one scenario (spec Section 3.3): initialize the variable context,
 * resolve scenario-level comparison rules, then run steps with
 * stop-on-first-failure. Setup/cleanup hook orchestration is added in the hooks
 * phase; cleanup must run even after a failed step.
 */
export async function runScenario(
  scenario: Scenario,
  scenarioFile: string,
  config: PharosConfig,
  registry: ContractRegistry,
  deps: RunnerDeps = {},
): Promise<ScenarioResult> {
  const start = performance.now();
  const send = deps.send ?? sendRequest;
  const env = deps.env ?? process.env;
  const ctx: VariableContext = {
    variables: structuredClone(scenario.variables ?? {}),
    env,
  };

  let scenarioRules: ComparisonRules | undefined;
  try {
    if (scenario.contract) {
      scenarioRules = resolveScenarioContractRules(scenario, scenarioFile, registry);
    }
  } catch (error) {
    return {
      scenarioId: scenario.id,
      name: scenario.name,
      pass: false,
      skipped: false,
      steps: [],
      error: error instanceof Error ? error.message : String(error),
      durationMs: performance.now() - start,
    };
  }

  const steps: StepResult[] = [];
  for (const step of scenario.steps) {
    const result = await runStep(scenario, step, ctx, config, scenarioRules, {
      send,
      comparators: deps.comparators,
    });
    steps.push(result);
    if (!result.pass) break; // stop-on-first-failure within a scenario
  }

  return {
    scenarioId: scenario.id,
    name: scenario.name,
    pass: steps.length > 0 && steps.every((step) => step.pass),
    skipped: false,
    steps,
    durationMs: performance.now() - start,
  };
}
