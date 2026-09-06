import type { Mismatch } from '../comparison/result';
import { DEFAULT_MIN_SCENARIOS, type PharosConfig } from '../config/config';
import { assertAccounting, type RunAccounting } from '../execution/run-all';
import type { ScenarioResult } from '../execution/runner';

/**
 * The machine-readable run report (spec Section 11.2). Built from scenario
 * results with the raw legacy/new responses deliberately omitted — only the
 * already-redacted comparison summary, mismatches, and diff text are included,
 * so the report (and the JUnit rendering of it) never carries a secret. The full
 * redacted responses live in the failure artifacts instead.
 *
 * Report keys are camelCase (`startedAt`, `minScenarios`) while config keys are
 * snake_case (`min_scenarios`): the two vocabularies coexist on purpose — the
 * on-disk config vocabulary is the portable one shared with limen, the report
 * is a JSON document read by CI.
 */

export interface ReportStep {
  stepId: string;
  name?: string;
  pass: boolean;
  error?: string;
  summary?: string;
  mismatches?: Mismatch[];
  diffText?: string;
  /** A bounded mismatch list was clipped, so the diff is a sample (spec Section 8.6). */
  diffTruncated?: boolean;
  artifactDir?: string;
  recordingPath?: string;
  recordingSkipped?: boolean;
}

export interface ReportScenario {
  scenarioId: string;
  name: string;
  pass: boolean;
  skipped: boolean;
  skipReason?: string;
  error?: string;
  durationMs: number;
  steps: ReportStep[];
}

/** The verdict of the run's scenario floor (spec Section 11.5). */
export interface RunFloorResult {
  /**
   * The floor this command handed the evaluator: `min_scenarios` /
   * `MIN_SCENARIOS` / `--min-scenarios` for `run`; `record` substitutes its own
   * (`min(min_scenarios, 1)`, or `--min-scenarios` verbatim — see `cli/record.ts`).
   */
  minScenarios: number;
  /** The floor's numerator — scenarios that actually ran. */
  executed: number;
  /**
   * The floor actually enforced — the effective floor after the
   * command-specific rules and any explicit `--min-scenarios`: 1 for a
   * `--scenario <id>` run (naming a scenario is the statement that it must
   * run), otherwise `minScenarios`. Under `min_scenarios: 20` a `run` applies
   * 20 and `record` applies 1 (3 with `record --min-scenarios 3`).
   */
  applied: number;
  met: boolean;
  /** Why the floor was not met — names the directory, filter, or gate. */
  reason?: string;
}

export interface RunSummary {
  /** Scenarios with a reported result (executed + parse-failed + gated). */
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Scenario files found on disk — the run's real denominator. */
  discovered: number;
  /** Dropped by mode or tag/id filtering. */
  filtered: number;
  parseFailed: number;
  refused: number;
  executed: number;
  narrowed: string[];
  floor: RunFloorResult;
}

export interface TestRunReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: RunSummary;
  scenarios: ReportScenario[];
}

function toReportStep(step: ScenarioResult['steps'][number]): ReportStep {
  return {
    stepId: step.stepId,
    name: step.name,
    pass: step.pass,
    error: step.error,
    summary: step.comparison?.summary,
    mismatches: step.comparison?.mismatches,
    diffText: step.comparison?.diffText,
    diffTruncated: step.comparison?.diffTruncated,
    artifactDir: step.artifactDir,
    recordingPath: step.recordingPath,
    recordingSkipped: step.recordingSkipped,
  };
}

/** The narrowing clause appended to a filtered count in floor messages. */
function narrowingSuffix(accounting: RunAccounting): string {
  return accounting.narrowed.length > 0 ? ` by ${accounting.narrowed.join(' ')}` : '';
}

/**
 * Spell out where every discovered file went. Used whenever the floor is unmet,
 * so the operator reads the classification that emptied the run rather than a
 * bare count.
 */
function describeClassifications(accounting: RunAccounting): string {
  const parts = [`${accounting.discovered} discovered`];
  const filtered = accounting.filteredByMode + accounting.filteredByFilter;
  if (filtered > 0) parts.push(`${filtered} filtered${narrowingSuffix(accounting)}`);
  if (accounting.parseFailed > 0) parts.push(`${accounting.parseFailed} failed to parse`);
  if (accounting.safetySkipped > 0) {
    parts.push(`${accounting.safetySkipped} skipped by a safety gate`);
  }
  if (accounting.refused > 0) parts.push(`${accounting.refused} refused`);
  parts.push(`${accounting.executed} executed`);
  const gates =
    accounting.gateReasons.length > 0 ? ` (gates: ${accounting.gateReasons.join('; ')})` : '';
  return `${parts.join(', ')}${gates}`;
}

/** Rule 1's message: name the directory when nothing was found, else the classification. */
function zeroExecutionReason(accounting: RunAccounting): string {
  const named = accounting.namedScenarioId
    ? `--scenario '${accounting.namedScenarioId}' was selected but did not run — `
    : '';
  if (accounting.discovered === 0) {
    const state =
      accounting.scenarioDirState === 'missing'
        ? 'does not exist'
        : accounting.scenarioDirState === 'not-a-directory'
          ? 'is not a directory'
          : accounting.scenarioDirState === 'unreadable'
            ? 'is not readable (permission denied)'
            : 'exists but holds no *.yaml/*.yml/*.json scenario files';
    return `no scenarios executed: ${named}scenario_dir '${accounting.scenarioDir}' ${state}`;
  }
  // An unresolved `--scenario` composes its own message in `run-all.ts` (which
  // knows the parse failures it may be hiding behind). It used to throw there
  // and exit 1 before any report was written; it is a floor outcome now, so the
  // message travels on the accounting instead.
  if (accounting.namedScenarioUnresolved) {
    return `no scenarios executed: ${accounting.namedScenarioUnresolved}`;
  }
  return `no scenarios executed: ${named}${describeClassifications(accounting)}`;
}

/**
 * The run's scenario floor (spec Section 11.5), shared by `run` and `record` so
 * both commands gate on the same rule. The numerator is `executed` and never
 * `passed + failed`: a parse failure or a production refusal is a reported
 * result, not evidence that a scenario ran.
 */
export function evaluateRunFloor(
  accounting: RunAccounting,
  config: Pick<PharosConfig, 'min_scenarios'>,
): RunFloorResult {
  const minScenarios = config.min_scenarios;
  // Rule 2: `--scenario <id>` sets the floor to 1 whatever the config says.
  const applied = accounting.namedScenarioId === undefined ? minScenarios : 1;
  const executed = accounting.executed;

  // Rule 1: zero executed scenarios is never a pass — not even under
  // `min_scenarios: 0`, whose opt-out (rule 4) is from the *minimum* only.
  if (executed === 0) {
    return { minScenarios, executed, applied, met: false, reason: zeroExecutionReason(accounting) };
  }
  if (executed >= applied) return { minScenarios, executed, applied, met: true };
  // Rule 3: narrowing by tag or mode keeps the configured floor — a renamed
  // tag shrinking the suite to three scenarios must not exit 0.
  return {
    minScenarios,
    executed,
    applied,
    met: false,
    reason:
      `only ${executed} scenario(s) executed, below the floor of ${applied} ` +
      `(min_scenarios): ${describeClassifications(accounting)}`,
  };
}

/**
 * Build the run report. `accounting` is required and must be the counted one
 * `runProject` returned: a synthesized fallback (discovered = results.length,
 * everything else derived) reduces both accounting invariants to
 * `results.length === results.length` — the tautology this design exists to
 * remove — and would count parse failures and refusals as `executed`, which the
 * floor's numerator forbids.
 *
 * {@link assertAccounting} lives in `run-all.ts` and already ran there, on the
 * accounting this is handed. Re-asserting is defence in depth for a caller that
 * assembled one itself.
 */
export function buildReport(
  results: ScenarioResult[],
  startedAt: string,
  finishedAt: string,
  accounting: RunAccounting,
  config?: Pick<PharosConfig, 'min_scenarios'>,
): TestRunReport {
  assertAccounting(accounting, results.length);

  const scenarios: ReportScenario[] = results.map((result) => ({
    scenarioId: result.scenarioId,
    name: result.name,
    pass: result.pass,
    skipped: result.skipped,
    skipReason: result.skipReason,
    error: result.error,
    durationMs: result.durationMs,
    steps: result.steps.map(toReportStep),
  }));

  const skipped = scenarios.filter((s) => s.skipped).length;
  const passed = scenarios.filter((s) => s.pass && !s.skipped).length;
  const failed = scenarios.filter((s) => !s.pass && !s.skipped).length;
  const floor = evaluateRunFloor(accounting, {
    min_scenarios: config?.min_scenarios ?? DEFAULT_MIN_SCENARIOS,
  });

  return {
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    summary: {
      total: scenarios.length,
      passed,
      failed,
      skipped,
      discovered: accounting.discovered,
      filtered: accounting.filteredByMode + accounting.filteredByFilter,
      parseFailed: accounting.parseFailed,
      refused: accounting.refused,
      executed: accounting.executed,
      narrowed: accounting.narrowed,
      floor,
    },
    scenarios,
  };
}

/**
 * Exit code convention (spec Section 11.5): `20` when the run's scenario floor
 * was not met, `1` when a scenario failed, else `0`. Precedence is 20 > 1 > 0 —
 * insufficient evidence makes the lower finding incomplete, and `20` is the
 * same number limen uses for the same idea so wrappers running both tools carry
 * one vocabulary.
 */
export function exitCodeFor(report: TestRunReport): number {
  if (!report.summary.floor.met) return 20;
  return report.summary.failed > 0 ? 1 : 0;
}
