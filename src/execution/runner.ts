import { performance } from 'node:perf_hooks';
import type { CustomComparator } from '../comparison/compare';
import type { ComparisonRules } from '../comparison/rules';
import { maskText, SensitiveValues } from '../comparison/sensitive';
import type { PharosConfig } from '../config/config';
import type { ContractRegistry } from '../contract/load';
import { resolveScenarioContractRules } from '../contract/resolve';
import type { Scenario } from '../scenarios/schema';
import { CookieJar } from './cookies';
import { type HookContext, type HookFn, runHooks } from './hooks';
import { sendRequest } from './http-client';
import { type CookieJars, runStep, type SendFn, type StepResult } from './step-runner';
import type { VariableContext } from './variables';

export interface ScenarioResult {
  scenarioId: string;
  name: string;
  pass: boolean;
  skipped: boolean;
  /** Why the scenario was skipped (safety gate), if it was. */
  skipReason?: string;
  steps: StepResult[];
  /** Lifecycle error (contract resolution, setup/cleanup hooks) that isn't a step mismatch. */
  error?: string;
  durationMs: number;
}

export interface RunnerDeps {
  send?: SendFn;
  env?: NodeJS.ProcessEnv;
  hooks?: Record<string, HookFn>;
  comparators?: Record<string, CustomComparator>;
  /** Allow legacy_record steps to write recordings (defaults to config.allow_recording_updates). */
  recordingEnabled?: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Orchestrate one scenario (spec Section 3.3): initialize the variable context,
 * resolve scenario-level comparison rules, run scenario setup hooks, then step
 * before/after hooks around each step with stop-on-first-failure — and run
 * **cleanup hooks unconditionally**, even after a failed step (Section 7.2).
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
  const hooks = deps.hooks ?? {};
  // Scenario-scoped, like the variable store it sits beside: values extracted
  // from secret-bearing sources are registered here as the scenario runs, and
  // every output boundary masks through it (spec Section 8.5). It is created
  // and discarded with the run, so nothing leaks into the next scenario.
  const sensitive = new SensitiveValues();
  const ctx: VariableContext = {
    variables: structuredClone(scenario.variables ?? {}),
    env,
    sensitive,
  };
  // Jars are created here and discarded with the run: one per target so legacy
  // and new never share cookies, and none survives into the next scenario
  // (spec Section 4.6).
  const cookieJars: CookieJars | undefined = scenario.cookies
    ? { legacy: new CookieJar(), new: new CookieJar() }
    : undefined;
  const hookCtx: HookContext = {
    scenarioId: scenario.id,
    variables: ctx.variables,
    env,
    legacyBaseUrl: config.legacy_base_url,
    newBaseUrl: config.new_base_url,
  };

  const finish = (steps: StepResult[], error: string | undefined): ScenarioResult => ({
    scenarioId: scenario.id,
    name: scenario.name,
    pass:
      error === undefined && steps.length === scenario.steps.length && steps.every((s) => s.pass),
    skipped: false,
    steps,
    // A lifecycle error is free text from a hook, which reads the same variable
    // store the extractions write to — mask it like a step's error.
    error: error === undefined ? undefined : maskText(error, sensitive),
    durationMs: performance.now() - start,
  });

  let scenarioRules: ComparisonRules | undefined;
  try {
    if (scenario.contract) {
      scenarioRules = resolveScenarioContractRules(scenario, scenarioFile, registry);
    }
  } catch (error) {
    return finish([], messageOf(error));
  }

  const steps: StepResult[] = [];
  let lifecycleError: string | undefined;
  try {
    await runHooks(scenario.setup?.hooks, hookCtx, hooks);
    for (const step of scenario.steps) {
      const stepHookCtx: HookContext = { ...hookCtx, stepId: step.id };
      await runHooks(step.before?.hooks, stepHookCtx, hooks);
      const result = await runStep(scenario, step, ctx, config, scenarioRules, {
        send,
        comparators: deps.comparators,
        recordingEnabled: deps.recordingEnabled ?? config.allow_recording_updates,
        cookieJars,
      });
      try {
        await runHooks(step.after?.hooks, stepHookCtx, hooks);
      } catch (error) {
        result.pass = false;
        result.error = result.error ?? maskText(`after hook: ${messageOf(error)}`, sensitive);
      }
      steps.push(result);
      if (!result.pass) break; // stop-on-first-failure within a scenario
    }
  } catch (error) {
    // Setup or a before hook failed: stop, but still run cleanup below.
    lifecycleError = messageOf(error);
  } finally {
    try {
      await runHooks(scenario.cleanup?.hooks, hookCtx, hooks);
    } catch (error) {
      lifecycleError = lifecycleError
        ? `${lifecycleError}; cleanup: ${messageOf(error)}`
        : `cleanup: ${messageOf(error)}`;
    }
  }

  return finish(steps, lifecycleError);
}
