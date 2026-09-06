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

/**
 * The run's accounting as testsuite properties. CI listings hide properties, so
 * the narrowing also goes in the suite *name* — a tag-narrowed run must not
 * read as a full one at a glance (pharos#12).
 *
 * Every classification is here, not just the headline pair: `executed` being
 * below `discovered` is the alarm, and `filtered` / `parseFailed` / `refused` /
 * `safetySkipped` are the four answers to "why", readable by a CI consumer
 * without opening the JSON report. `floor.applied` is carried next to
 * `floor.minScenarios` because they differ on a `--scenario` run.
 */
function renderProperties(report: TestRunReport): string {
  const { discovered, executed, filtered, parseFailed, refused, skipped, narrowed, floor } =
    report.summary;
  const entries: Array<[string, string]> = [
    ['discovered', String(discovered)],
    ['executed', String(executed)],
    ['filtered', String(filtered)],
    ['parseFailed', String(parseFailed)],
    ['refused', String(refused)],
    // Every skip is a safety-gate skip (spec Section 12); named for the gate so
    // it is not read as the testsuite's own `skipped` attribute.
    ['safetySkipped', String(skipped)],
    ['floor.minScenarios', String(floor.minScenarios)],
    ['floor.applied', String(floor.applied)],
    ['narrowed', narrowed.join(' ')],
  ];
  return [
    '    <properties>',
    ...entries.map(
      ([name, value]) => `      <property name="${name}" value="${escapeXml(value)}"/>`,
    ),
    '    </properties>',
  ].join('\n');
}

export function renderJunitXml(report: TestRunReport): string {
  const { total, failed, skipped, narrowed, floor } = report.summary;
  const cases = report.scenarios.map(renderCase).join('\n');
  // An unmet floor is an error on the suite itself, not a scenario failure:
  // the synthetic testcase is what makes it visible in a CI test listing, and
  // `tests` counts it so the attribute matches the testcase elements present.
  const errors = floor.met ? 0 : 1;
  const tests = total + errors;
  const floorCase = floor.met
    ? undefined
    : `    <testcase name="pharos.min_scenarios" classname="pharos"><error message="${escapeXml(
        floor.reason ?? 'the run scenario floor was not met',
      )}"/></testcase>`;
  const name = narrowed.length > 0 ? `pharos [narrowed: ${narrowed.join(' ')}]` : 'pharos';
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${tests}" failures="${failed}" errors="${errors}" skipped="${skipped}">`,
    `  <testsuite name="${escapeXml(name)}" tests="${tests}" failures="${failed}" errors="${errors}" skipped="${skipped}" time="${seconds(
      report.durationMs,
    )}">`,
    renderProperties(report),
    ...(cases === '' ? [] : [cases]),
    ...(floorCase ? [floorCase] : []),
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
