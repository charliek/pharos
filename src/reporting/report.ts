import type { Mismatch } from '../comparison/result';
import type { ScenarioResult } from '../execution/runner';

/**
 * The machine-readable run report (spec Section 11.2). Built from scenario
 * results with the raw legacy/new responses deliberately omitted — only the
 * already-redacted comparison summary, mismatches, and diff text are included,
 * so the report (and the JUnit rendering of it) never carries a secret. The full
 * redacted responses live in the failure artifacts instead.
 */

export interface ReportStep {
  stepId: string;
  name?: string;
  pass: boolean;
  error?: string;
  summary?: string;
  mismatches?: Mismatch[];
  diffText?: string;
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

export interface TestRunReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: { total: number; passed: number; failed: number; skipped: number };
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
    artifactDir: step.artifactDir,
    recordingPath: step.recordingPath,
    recordingSkipped: step.recordingSkipped,
  };
}

export function buildReport(
  results: ScenarioResult[],
  startedAt: string,
  finishedAt: string,
): TestRunReport {
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

  return {
    startedAt,
    finishedAt,
    durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    summary: { total: scenarios.length, passed, failed, skipped },
    scenarios,
  };
}

/** Exit code convention (spec Section 11.5): non-zero when any required scenario failed. */
export function exitCodeFor(report: TestRunReport): number {
  return report.summary.failed > 0 ? 1 : 0;
}
