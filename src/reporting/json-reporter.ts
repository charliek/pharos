import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestRunReport } from './report';

/** Write the machine-readable JSON report (spec Section 11.2) to `reportDir/report.json`. */
export function writeJsonReport(reportDir: string, report: TestRunReport): string {
  mkdirSync(reportDir, { recursive: true });
  const path = join(reportDir, 'report.json');
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}
