import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReportScenario, TestRunReport } from './report';

/** JUnit XML report (spec Section 11.3) for CI-native integration. */

const XML_ESCAPES: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  "'": '&apos;',
  '"': '&quot;',
};

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (char) => XML_ESCAPES[char] ?? char);
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3);
}

function renderCase(scenario: ReportScenario): string {
  const name = escapeXml(scenario.scenarioId);
  if (scenario.skipped) {
    return `    <testcase name="${name}" classname="pharos"><skipped message="${escapeXml(
      scenario.skipReason ?? 'skipped',
    )}"/></testcase>`;
  }
  const time = seconds(scenario.durationMs);
  if (scenario.pass) {
    return `    <testcase name="${name}" classname="pharos" time="${time}"/>`;
  }
  const detail = [
    scenario.error,
    ...scenario.steps
      .filter((step) => !step.pass)
      .map(
        (step) =>
          `${step.stepId}: ${step.summary ?? step.error ?? 'failed'}\n${step.diffText ?? ''}` +
          // Say so when a bounded list was clipped, or CI reads the diff as the
          // whole story (spec Section 8.6).
          (step.diffTruncated ? '\n… more differences were truncated' : ''),
      ),
  ]
    .filter(Boolean)
    .join('\n');
  return `    <testcase name="${name}" classname="pharos" time="${time}"><failure message="scenario failed">${escapeXml(
    detail,
  )}</failure></testcase>`;
}

export function renderJunitXml(report: TestRunReport): string {
  const { total, failed, skipped } = report.summary;
  const cases = report.scenarios.map(renderCase).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${total}" failures="${failed}" skipped="${skipped}">`,
    `  <testsuite name="pharos" tests="${total}" failures="${failed}" skipped="${skipped}" time="${seconds(
      report.durationMs,
    )}">`,
    cases,
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n');
}

export function writeJunitReport(reportDir: string, report: TestRunReport): string {
  mkdirSync(reportDir, { recursive: true });
  const path = join(reportDir, 'junit.xml');
  writeFileSync(path, renderJunitXml(report));
  return path;
}
