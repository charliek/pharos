import { stableStringify } from './normalize';
import type { Mismatch } from './result';

/**
 * Readable, structural JSON diff. Walks `expected` (legacy/reference) against
 * `actual` (new), emitting path-addressed mismatches. Inputs are assumed already
 * normalized, so redacted/ignored fields never appear here.
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
          message: 'missing in new',
        });
      } else if (!inExpected && inActual) {
        out.push({
          path: childPath,
          kind: 'extra',
          actual: actualObj[key],
          message: 'unexpected in new',
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
          message: 'missing in new',
        });
      } else if (i >= expectedArr.length) {
        out.push({
          path: childPath,
          kind: 'extra',
          actual: actualArr[i],
          message: 'unexpected in new',
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

/** Render mismatches as readable, bounded text for the console and artifacts. */
export function renderMismatches(mismatches: Mismatch[]): string {
  return mismatches
    .map((mismatch) => {
      switch (mismatch.kind) {
        case 'missing':
          return `${mismatch.path}: missing in new (legacy: ${preview(mismatch.expected)})`;
        case 'extra':
          return `${mismatch.path}: unexpected in new (new: ${preview(mismatch.actual)})`;
        case 'status':
          return `${mismatch.path}: ${mismatch.message} (legacy: ${preview(mismatch.expected)}, new: ${preview(mismatch.actual)})`;
        default:
          return `${mismatch.path}: ${mismatch.message} (legacy: ${preview(mismatch.expected)}, new: ${preview(mismatch.actual)})`;
      }
    })
    .join('\n');
}
