import type { TestRunReport } from './report';

/** Developer-facing console output (spec Section 11.1). */

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n');
}

export function renderConsoleReport(report: TestRunReport): string {
  const lines: string[] = [];

  for (const scenario of report.scenarios) {
    if (scenario.skipped) {
      lines.push(`- ${scenario.scenarioId} (skipped: ${scenario.skipReason ?? 'skipped'})`);
      continue;
    }
    if (scenario.pass) {
      lines.push(`✓ ${scenario.scenarioId}`);
      continue;
    }

    lines.push(`✗ ${scenario.scenarioId} — ${scenario.name}`);
    if (scenario.error) lines.push(`    ${scenario.error}`);
    for (const step of scenario.steps) {
      if (step.pass) continue;
      lines.push(`    step '${step.stepId}': ${step.summary ?? step.error ?? 'failed'}`);
      if (step.diffText) lines.push(indent(step.diffText, 6));
      // Say so when the list was clipped, or the diff reads as the whole story.
      if (step.diffTruncated) lines.push('      … more differences were truncated');
      if (step.artifactDir) lines.push(`      artifacts: ${step.artifactDir}`);
    }
  }

  const {
    discovered,
    executed,
    passed,
    failed,
    skipped,
    filtered,
    parseFailed,
    refused,
    narrowed,
  } = report.summary;
  // `discovered` leads the line on purpose: the run's denominator is what it
  // found on disk, not what survived filtering (pharos#12). The optional
  // segments appear only when non-zero so an ordinary run stays one line.
  const segments = [
    `${discovered} discovered`,
    `${executed} executed`,
    `${passed} passed`,
    `${failed} failed`,
    `${skipped} skipped`,
  ];
  if (filtered > 0) {
    segments.push(
      narrowed.length > 0 ? `${filtered} filtered (${narrowed.join(' ')})` : `${filtered} filtered`,
    );
  }
  if (parseFailed > 0) segments.push(`parse-failed ${parseFailed}`);
  if (refused > 0) segments.push(`refused ${refused}`);
  lines.push('');
  lines.push(`${segments.join(' · ')} (${report.durationMs}ms)`);
  const floor = report.summary.floor;
  if (!floor.met) lines.push(`✗ run floor not met: ${floor.reason ?? 'min_scenarios'}`);
  return `${lines.join('\n')}\n`;
}
