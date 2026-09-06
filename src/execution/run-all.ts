import { existsSync, statSync } from 'node:fs';
import type { PharosConfig } from '../config/config';
import { assertConfigForModes, assertProductionUrlGuard } from '../config/validate';
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
 * What the resolved `scenario_dir` was at discovery time. Recorded because a
 * run that discovered nothing has to say *why* (spec Section 11.5, pharos#12):
 * a misspelled directory, a path that is not a directory, an unreadable one
 * and an empty one are four different operator mistakes, and all of them used
 * to print the same silent `0 scenario(s) … exit 0` (or, for the unreadable
 * case, a raw `EACCES … scandir` stack trace with no report written).
 */
export type ScenarioDirState = 'ok' | 'missing' | 'not-a-directory' | 'unreadable' | 'empty';

/**
 * The run's denominator, counted (never derived). Every file discovery found
 * gets exactly one terminal classification here, incremented at the site that
 * decides it — so a future unaccounted `continue` makes the sum come up short
 * and {@link buildReport}'s invariant fires, instead of quietly shrinking the
 * denominator the way pharos#12 describes.
 */
export interface RunAccounting {
  /** The resolved (absolute) scenario directory this run read. */
  scenarioDir: string;
  scenarioDirState: ScenarioDirState;
  /** Files fast-glob found under `scenarioDir`. */
  discovered: number;
  /** Files that failed to parse (reported as failing results). */
  parseFailed: number;
  /** Dropped by the mode filter (`record` restricts to `legacy_record`). */
  filteredByMode: number;
  /** Dropped by `--scenario` / `--include-tag` / `--exclude-tag`. */
  filteredByFilter: number;
  /** Dropped by a safety gate as a skip (spec Section 12). */
  safetySkipped: number;
  /** Refused by the production fail-closed profile (failing results). */
  refused: number;
  /** Scenarios that actually ran — the floor's numerator. */
  executed: number;
  /** The explicit narrowing in effect, e.g. `['--exclude-tag jwt']`. */
  narrowed: string[];
  /**
   * The id `--scenario` named, if any. The floor is 1 for such a run (spec
   * Section 11.5 rule 2) regardless of `min_scenarios`: naming a scenario is
   * itself the statement that it must run.
   */
  namedScenarioId?: string;
  /**
   * Why the id `--scenario` named never reached the run set: it matched no
   * scenario, or a tag/mode filter erased it. Carries the whole composed
   * message (including the parse-failure detail) because that message is the
   * only actionable thing about such a run. Set instead of throwing: an
   * unresolved `--scenario` is an operator mistake of exactly the same class
   * as one the safety gate blocks, and that one has always been a floor
   * outcome — see the guard below for why the two must not exit differently.
   */
  namedScenarioUnresolved?: string;
  /**
   * Distinct reasons the safety gates gave, in discovery order. Carried so a
   * zero-execution run can name the gate that emptied the set rather than only
   * counting it — "`--scenario destructive` was skipped" is not actionable
   * without the reason.
   */
  gateReasons: string[];
}

/** A project run: its results plus the accounting that makes them countable. */
export interface ProjectRun {
  results: ScenarioResult[];
  accounting: RunAccounting;
}

/** Render the narrowing in effect for reports and floor messages. */
function describeNarrowing(options: RunProjectOptions): string[] {
  const narrowed: string[] = [];
  if (options.scenarioId) narrowed.push(`--scenario ${options.scenarioId}`);
  if (options.includeTags?.length) narrowed.push(`--include-tag ${options.includeTags.join(' ')}`);
  if (options.excludeTags?.length) narrowed.push(`--exclude-tag ${options.excludeTags.join(' ')}`);
  if (options.modes?.length) narrowed.push(`modes: ${options.modes.join(', ')}`);
  return narrowed;
}

/**
 * Classify the resolved scenario directory, then discover the scenario files in
 * it. Classification happens here rather than in `discoverScenarioFiles`, whose
 * contract ("a missing directory simply yields no files") is shared with
 * contract discovery and pinned by its own tests — and it happens *before*
 * discovery because fast-glob throws ENOTDIR when handed a regular file, and a
 * `scenario_dir` pointing at one is an operator mistake that deserves a named
 * state rather than a stack trace.
 *
 * A directory the process cannot *read* is the same class of mistake — a
 * container mounting the scenario volume with the wrong uid — and fast-glob
 * raises a bare `EACCES: permission denied, scandir …` for it, which would
 * exit 1 with no report written. It is "the harness could not read the suite",
 * so it becomes a fifth state and a floor outcome like the other four. Only
 * the permission errnos are absorbed: anything else from discovery is a bug or
 * an exhausted resource, and stays loud.
 */
function discoverWithState(dir: string): { files: string[]; state: ScenarioDirState } {
  if (!existsSync(dir)) return { files: [], state: 'missing' };
  if (!statSync(dir).isDirectory()) return { files: [], state: 'not-a-directory' };
  let files: string[];
  try {
    files = discoverScenarioFiles(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'EACCES' && code !== 'EPERM') throw error;
    return { files: [], state: 'unreadable' };
  }
  return { files, state: files.length > 0 ? 'ok' : 'empty' };
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
): Promise<ProjectRun> {
  // production_url_patterns guard (spec Section 12): before any scenario or
  // request work, refuse a run whose base URL(s) look like production while
  // environment != production.
  assertProductionUrlGuard(config);

  const hookRegistry = await loadHookRegistry(config.hooks_module);
  const contractRegistry = new ContractRegistry();

  const { files: discoveredFiles, state: scenarioDirState } = discoverWithState(
    config.scenario_dir,
  );
  const accounting: RunAccounting = {
    scenarioDir: config.scenario_dir,
    scenarioDirState,
    discovered: discoveredFiles.length,
    parseFailed: 0,
    filteredByMode: 0,
    filteredByFilter: 0,
    safetySkipped: 0,
    refused: 0,
    executed: 0,
    narrowed: describeNarrowing(options),
    namedScenarioId: options.scenarioId,
    gateReasons: [],
  };

  const selected: Array<{ file: string; scenario: Scenario }> = [];
  const loadFailures: ScenarioResult[] = [];
  // Tracks whether a scenario with id === options.scenarioId was found among
  // successfully-parsed scenarios, independent of tag/mode filtering — used
  // below to distinguish "no such scenario" from "filtered out" in the
  // accounting-hole check.
  let requestedScenarioParsed = false;
  for (const file of discoveredFiles) {
    let scenario: Scenario;
    try {
      scenario = loadScenarioFile(file);
    } catch (error) {
      loadFailures.push(loadFailureResult(file, error));
      accounting.parseFailed += 1;
      continue;
    }
    if (options.scenarioId && scenario.id === options.scenarioId) requestedScenarioParsed = true;
    // Every drop below is counted where it is decided: the denominator is part
    // of the run's identity, not whatever happened to survive (pharos#12).
    if (options.modes && !options.modes.includes(scenario.mode)) {
      accounting.filteredByMode += 1;
      continue;
    }
    if (!matchesFilter(scenario, options)) {
      accounting.filteredByFilter += 1;
      continue;
    }
    selected.push({ file, scenario });
  }

  // Accounting hole (spec Section 11.5): a tag/mode filter can silently erase
  // an explicitly-named `--scenario` selection — including one that would
  // have been a production refusal — leaving it out of every result and
  // yielding a false green (0 scenarios, exit 0). If the caller named a
  // scenario and, after filtering, it isn't in the run set, say so instead of
  // reporting nothing for it. Applies in every environment.
  //
  // A second accounting hole: the file `--scenario` names might be exactly
  // the one that failed to *parse* — its id was never even extracted, so
  // `requestedScenarioParsed` stays false and this would otherwise be
  // reported as an indistinguishable "no such scenario id", masking the real
  // parse failure the caller actually needs to see. When any file failed to
  // parse, surface that detail alongside (or instead of) the generic message.
  //
  // This **replaces a `throw new ConfigError(...)` guard** — do not reinstate
  // it. That throw became `process.exit(1)` in `cli/run.ts` *before any report
  // was written*, while the neighbouring case (a `--scenario` the safety gate
  // blocked) exits 20 with both reports on disk. Same operator mistake, two
  // exit codes, and on the exit-1 path a CI job that publishes
  // `reports/junit.xml` republishes the previous run's file: a stale green
  // artifact on a red build. Recording the reason and letting `executed` stay
  // 0 routes both cases through rule 1 of {@link evaluateRunFloor}.
  //
  // Nothing runs after this point either way: `matchesFilter` keeps only the
  // named id, so `selected` is empty exactly when the named scenario is not in
  // it. The pipeline continues so every discovered file still gets its counted
  // classification and the accounting invariant stays meaningful.
  if (options.scenarioId && !selected.some((entry) => entry.scenario.id === options.scenarioId)) {
    accounting.namedScenarioUnresolved = requestedScenarioParsed
      ? `--scenario '${options.scenarioId}' matched a scenario file but was filtered out ` +
        'by --include-tag/--exclude-tag (or the active modes) — nothing would be reported for it'
      : loadFailures.length > 0
        ? `--scenario '${options.scenarioId}' did not match any successfully-parsed scenario id ` +
          `under ${config.scenario_dir}, and ${loadFailures.length} scenario file` +
          `${loadFailures.length === 1 ? '' : 's'} failed to parse — it may be one of these: ` +
          loadFailures.map((failure) => `${failure.scenarioId} (${failure.error})`).join('; ')
        : `--scenario '${options.scenarioId}' did not match any scenario id under ${config.scenario_dir}`;
  }

  // Apply safety gates before requiring config: a skipped or refused scenario
  // imposes no base-URL requirement because it never runs. Refusal (production
  // fail-closed) is checked first; scenarios it doesn't apply to still go
  // through the ordinary skip gates — the gates compose (spec Section 12).
  const toRun: Array<{ file: string; scenario: Scenario }> = [];
  const gated: ScenarioResult[] = [];
  const gateReasons = new Set<string>();
  for (const entry of selected) {
    const refusal = scenarioRefusalReason(entry.scenario, config);
    if (refusal) {
      gated.push(refusedResult(entry.scenario, refusal));
      accounting.refused += 1;
      gateReasons.add(refusal);
      continue;
    }
    const reason = scenarioSkipReason(entry.scenario, config);
    if (reason) {
      gated.push(skippedResult(entry.scenario, reason));
      accounting.safetySkipped += 1;
      gateReasons.add(reason);
    } else {
      toRun.push(entry);
    }
  }
  // `toRun` is the run set from here to the loop below: nothing between this
  // line and it removes an entry, so `executed` counts what actually ran.
  accounting.executed = toRun.length;
  accounting.gateReasons = [...gateReasons];

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
  return { results, accounting };
}
