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
      if (step.artifactDir) lines.push(`      artifacts: ${step.artifactDir}`);
    }
  }

  const { total, passed, failed, skipped } = report.summary;
  lines.push('');
  lines.push(
    `${total} scenario(s): ${passed} passed, ${failed} failed, ${skipped} skipped (${report.durationMs}ms)`,
  );
  return `${lines.join('\n')}\n`;
}

export function printConsoleReport(report: TestRunReport): void {
  process.stdout.write(renderConsoleReport(report));
}
