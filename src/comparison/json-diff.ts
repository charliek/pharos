import { stableStringify } from './normalize';
import type { Mismatch } from './result';

/**
 * Readable, structural JSON diff. Walks `expected` (legacy/reference) against
 * `actual` (new), emitting path-addressed mismatches. Inputs are assumed already
 * normalized, so redacted/ignored fields never appear here.
 *
 * Mismatch messages here are deliberately **side-neutral** ('missing', not
 * 'missing in new'): the same diff feeds two-sided comparisons, where the
 * `expected` side really is a legacy response, and one-sided expectation
 * assertions, where it is an author-written literal and no legacy response
 * exists at all. Naming the sides is {@link renderMismatches}'s job, since only
 * the renderer is told which vocabulary applies.
 */

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function diffJson(
  expected: unknown,
  actual: unknown,
  path = '$',
  out: Mismatch[] = [],
): Mismatch[] {
  const expectedType = typeOf(expected);
  const actualType = typeOf(actual);

  if (expectedType !== actualType) {
    out.push({
      path,
      kind: 'type',
      expected,
      actual,
      message: `type differs: ${expectedType} vs ${actualType}`,
    });
    return out;
  }

  if (expectedType === 'object') {
    const expectedObj = expected as Record<string, unknown>;
    const actualObj = actual as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(expectedObj), ...Object.keys(actualObj)])].sort();
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      const inExpected = key in expectedObj;
      const inActual = key in actualObj;
      if (inExpected && !inActual) {
        out.push({
          path: childPath,
          kind: 'missing',
          expected: expectedObj[key],
          message: 'missing',
        });
      } else if (!inExpected && inActual) {
        out.push({
          path: childPath,
          kind: 'extra',
          actual: actualObj[key],
          message: 'unexpected',
        });
      } else {
        diffJson(expectedObj[key], actualObj[key], childPath, out);
      }
    }
    return out;
  }

  if (expectedType === 'array') {
    const expectedArr = expected as unknown[];
    const actualArr = actual as unknown[];
    const max = Math.max(expectedArr.length, actualArr.length);
    for (let i = 0; i < max; i++) {
      const childPath = `${path}[${i}]`;
      if (i >= actualArr.length) {
        out.push({
          path: childPath,
          kind: 'missing',
          expected: expectedArr[i],
          message: 'missing',
        });
      } else if (i >= expectedArr.length) {
        out.push({
          path: childPath,
          kind: 'extra',
          actual: actualArr[i],
          message: 'unexpected',
        });
      } else {
        diffJson(expectedArr[i], actualArr[i], childPath, out);
      }
    }
    return out;
  }

  if (expected !== actual) {
    out.push({ path, kind: 'value', expected, actual, message: 'value differs' });
  }
  return out;
}

const MAX_PREVIEW = 200;

/** A bounded, single-line preview of a value for diff output. */
function preview(value: unknown): string {
  if (value === undefined) return '∅';
  const text = stableStringify(value);
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW - 3)}...` : text;
}

/**
 * Which vocabulary a rendered diff names the two sides with.
 *
 * `two_sided` — the comparison had a legacy/recorded response to compare
 * against, so a mismatch's `expected` really is what legacy sent: render
 * `legacy:` / `new:`.
 *
 * `expectation` — the comparison asserted the response against author-written
 * expectations (`explicit_expectations`, or a custom comparator with no legacy
 * side). Nothing here came from a legacy service, so calling the asserted value
 * `legacy:` would be a lie: render `expected:` / `actual:`.
 */
export type DiffVocabulary = 'two_sided' | 'expectation';

/**
 * Render mismatches as readable, bounded text for the console and artifacts.
 *
 * The renderer owns the whole line, side wording included — stored messages are
 * side-neutral so the same mismatch reads honestly under either vocabulary.
 */
export function renderMismatches(
  mismatches: Mismatch[],
  vocabulary: DiffVocabulary = 'two_sided',
): string {
  const asserted = vocabulary === 'expectation';
  const expectedLabel = asserted ? 'expected' : 'legacy';
  const actualLabel = asserted ? 'actual' : 'new';
  // Two-sided lines say *where* the value is missing from, because there are two
  // places it could be; one-sided assertions have only the response, so the
  // side clause would be noise.
  const side = asserted ? '' : ' in new';
  return mismatches
    .map((mismatch) => {
      switch (mismatch.kind) {
        case 'missing':
          return `${mismatch.path}: missing${side} (${expectedLabel}: ${preview(mismatch.expected)})`;
        case 'extra':
          return `${mismatch.path}: unexpected${side} (${actualLabel}: ${preview(mismatch.actual)})`;
        default:
          return `${mismatch.path}: ${mismatch.message} (${expectedLabel}: ${preview(mismatch.expected)}, ${actualLabel}: ${preview(mismatch.actual)})`;
      }
    })
    .join('\n');
}
