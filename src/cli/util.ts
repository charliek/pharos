import { relative } from 'node:path';
import type { FieldIssue } from '../errors';

/** Shorten an absolute path to a cwd-relative one for readable CLI output. */
export function relativePath(file: string): string {
  const rel = relative(process.cwd(), file);
  return rel === '' || rel.startsWith('..') ? file : rel;
}

/** Print a file's validation issues to stderr, one per line, field-addressed. */
export function printFileIssues(file: string, issues: FieldIssue[]): void {
  process.stderr.write(`✗ ${relativePath(file)}\n`);
  for (const issue of issues) {
    process.stderr.write(`    ${issue.path}: ${issue.message}\n`);
  }
}

/**
 * Placeholder action for a subcommand whose feature lands in a later phase
 * (spec Section 14). Exits non-zero with a clear message.
 */
export function notImplemented(command: string): never {
  process.stderr.write(`pharos ${command}: not yet implemented\n`);
  process.exit(1);
}
