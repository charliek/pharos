import { relative } from 'node:path';
import { parseMinScenariosValue } from '../config/env';
import type { FieldIssue } from '../errors';

/**
 * Parse `--min-scenarios`, shared by `run` and `record`. The flag and the
 * `MIN_SCENARIOS` env var are two spellings of one setting, so they go through
 * one parser and fail closed on identical inputs — including a floor above
 * `Number.MAX_SAFE_INTEGER`; see {@link parseMinScenariosValue} for the rule
 * and its reason. `undefined` means the flag was not given — which is not the
 * same as `0`, and `record` distinguishes them (see `record.ts`).
 */
export function parseMinScenarios(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  return parseMinScenariosValue(value, '--min-scenarios');
}

/** Shorten an absolute path to a cwd-relative one for readable CLI output. */
export function relativePath(file: string): string {
  const rel = relative(process.cwd(), file);
  return rel === '' || rel.startsWith('..') ? file : rel;
}

/**
 * Write `text` and resolve once the runtime has handed it to the OS.
 *
 * `process.exit` truncates a pending write when the stream is a pipe — which is
 * every CI job and every subprocess test — so a `write(...)` immediately
 * followed by `process.exit(20)` can lose the accounting line an operator needs
 * to act on. Verified under bun 1.3: 200KB written and then exited drops its
 * tail; awaiting the write's callback first does not. Awaiting the *last*
 * non-empty write to a stream is enough (writes are delivered in order), so
 * callers buffer and write once per stream. An empty write is not a barrier —
 * bun completes it without draining what is queued ahead of it — hence the
 * early return, so `writeStream(stream, '')` cannot be mistaken for a flush.
 */
export function writeStream(stream: NodeJS.WriteStream, text: string): Promise<void> {
  if (text === '') return Promise.resolve();
  return new Promise((resolve) => {
    stream.write(text, () => resolve());
  });
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
