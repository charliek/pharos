import type { PharosConfig } from '../config/config';
import { assertConfigForModes, assertProductionUrlGuard } from '../config/validate';
import { ContractRegistry } from '../contract/load';
import { ConfigError, ValidationError } from '../errors';
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
 * undefined to run it. Destructive scenarios need explicit opt-in; the
 * production guard override gates `requiresProductionGuardOverride` scenarios.
 * Both apply regardless of `environment` — "the gates compose" (Section 12).
 *
 * The `allowedEnvironments` vs. `environment` check (Section 4.5) is handled
 * here only outside `environment: production`, where a mismatch is a plain
 * skip; inside `environment: production` the same mismatch is a **refusal**
 * instead (see {@link scenarioRefusalReason}), so this function deliberately
 * does not report it there.
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
  if (config.environment === 'production') return undefined;
  const allowed = scenario.safety?.allowedEnvironments;
  if (allowed && !allowed.includes(config.environment)) {
    return `not allowed in the '${config.environment}' environment`;
  }
  return undefined;
}

/**
 * The fail-closed production profile (spec Section 12): in `environment:
 * production`, a scenario runs only if `safety.allowedEnvironments` explicitly
 * includes `'production'`; anything else is refused. Returns the refusal
 * reason, or undefined when the scenario is tagged for production or the
 * configured environment isn't production at all (in which case
 * {@link scenarioSkipReason} handles any environment mismatch as a skip).
 */
function scenarioRefusalReason(scenario: Scenario, config: PharosConfig): string | undefined {
  if (config.environment !== 'production') return undefined;
  const allowed = scenario.safety?.allowedEnvironments;
  if (allowed?.includes('production')) return undefined;
  return 'refused: not allowed in the production environment (safety.allowedEnvironments)';
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

/**
 * A production refusal (spec Sections 11.5 + 12): a distinct failing scenario
 * result — `pass: false`, `skipped: false` — that contributes to a non-zero
 * exit code, unlike a skip. Deliberately a separate builder from
 * {@link skippedResult}: refusals and skips are different outcomes reported
 * differently (Section 11.5) even though both originate from a safety gate.
 */
function refusedResult(scenario: Scenario, reason: string): ScenarioResult {
  return {
    scenarioId: scenario.id,
    name: scenario.name,
    pass: false,
    skipped: false,
    error: reason,
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
  // production_url_patterns guard (spec Section 12): before any scenario or
  // request work, refuse a run whose base URL(s) look like production while
  // environment != production.
  assertProductionUrlGuard(config);

  const hookRegistry = await loadHookRegistry(config.hooks_module);
  const contractRegistry = new ContractRegistry();

  const selected: Array<{ file: string; scenario: Scenario }> = [];
  const loadFailures: ScenarioResult[] = [];
  // Tracks whether a scenario with id === options.scenarioId was found among
  // successfully-parsed scenarios, independent of tag/mode filtering — used
  // below to distinguish "no such scenario" from "filtered out" in the
  // accounting-hole check.
  let requestedScenarioParsed = false;
  for (const file of discoverScenarioFiles(config.scenario_dir)) {
    let scenario: Scenario;
    try {
      scenario = loadScenarioFile(file);
    } catch (error) {
      loadFailures.push(loadFailureResult(file, error));
      continue;
    }
    if (options.scenarioId && scenario.id === options.scenarioId) requestedScenarioParsed = true;
    if (options.modes && !options.modes.includes(scenario.mode)) continue;
    if (!matchesFilter(scenario, options)) continue;
    selected.push({ file, scenario });
  }

  // Accounting hole (spec Section 11.5): a tag/mode filter can silently erase
  // an explicitly-named `--scenario` selection — including one that would
  // have been a production refusal — leaving it out of every result and
  // yielding a false green (0 scenarios, exit 0). If the caller named a
  // scenario and, after filtering, it isn't in the run set, fail loudly
  // instead of reporting nothing for it. Applies in every environment.
  //
  // A second accounting hole: the file `--scenario` names might be exactly
  // the one that failed to *parse* — its id was never even extracted, so
  // `requestedScenarioParsed` stays false and this would otherwise be
  // reported as an indistinguishable "no such scenario id", masking the real
  // parse failure the caller actually needs to see. When any file failed to
  // parse, surface that detail alongside (or instead of) the generic message.
  if (options.scenarioId && !selected.some((entry) => entry.scenario.id === options.scenarioId)) {
    const reason = requestedScenarioParsed
      ? `--scenario '${options.scenarioId}' matched a scenario file but was filtered out ` +
        'by --include-tag/--exclude-tag (or the active modes) — nothing would be reported for it'
      : loadFailures.length > 0
        ? `--scenario '${options.scenarioId}' did not match any successfully-parsed scenario id ` +
          `under ${config.scenario_dir}, and ${loadFailures.length} scenario file` +
          `${loadFailures.length === 1 ? '' : 's'} failed to parse — it may be one of these: ` +
          loadFailures.map((failure) => `${failure.scenarioId} (${failure.error})`).join('; ')
        : `--scenario '${options.scenarioId}' did not match any scenario id under ${config.scenario_dir}`;
    throw new ConfigError([reason]);
  }

  // Apply safety gates before requiring config: a skipped or refused scenario
  // imposes no base-URL requirement because it never runs. Refusal (production
  // fail-closed) is checked first; scenarios it doesn't apply to still go
  // through the ordinary skip gates — the gates compose (spec Section 12).
  const toRun: Array<{ file: string; scenario: Scenario }> = [];
  const gated: ScenarioResult[] = [];
  for (const entry of selected) {
    const refusal = scenarioRefusalReason(entry.scenario, config);
    if (refusal) {
      gated.push(refusedResult(entry.scenario, refusal));
      continue;
    }
    const reason = scenarioSkipReason(entry.scenario, config);
    if (reason) gated.push(skippedResult(entry.scenario, reason));
    else toRun.push(entry);
  }

  // Fail fast if required base URLs are missing for the modes that will run.
  assertConfigForModes(config, new Set(toRun.map((entry) => entry.scenario.mode)));

  const results: ScenarioResult[] = [...loadFailures, ...gated];
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
