import { diffJson } from './json-diff';
import { getAtPath, parseJsonPath } from './jsonpath';
import { deepEqual } from './normalize';
import type { Mismatch } from './result';

/**
 * Value matchers for the `subset` and `explicit_expectations` strategies, where
 * comparison is scoped to specific JSONPaths rather than the whole body.
 */

/** Compare the value(s) at `path` between legacy and the candidate (subset strategy). */
export function matchPathBetween(
  legacyBody: unknown,
  candidateBody: unknown,
  path: string,
  out: Mismatch[],
): void {
  const segments = parseJsonPath(path);
  const legacyValues = getAtPath(legacyBody, segments);
  const candidateValues = getAtPath(candidateBody, segments);

  if (deepEqual(legacyValues, candidateValues)) return; // equal, incl. both absent

  if (legacyValues.length <= 1 && candidateValues.length <= 1) {
    if (legacyValues.length === 0) {
      out.push({
        path,
        kind: 'extra',
        actual: candidateValues[0],
        message: 'present in new but absent in legacy',
      });
    } else if (candidateValues.length === 0) {
      out.push({
        path,
        kind: 'missing',
        expected: legacyValues[0],
        message: 'present in legacy but absent in new',
      });
    } else {
      diffJson(legacyValues[0], candidateValues[0], path, out);
    }
    return;
  }
  // Wildcard match: compare the matched sets element-wise.
  diffJson(legacyValues, candidateValues, path, out);
}

/** Compare the value at `path` in `body` against an expected literal (explicit_expectations). */
export function matchPathExpectation(
  body: unknown,
  path: string,
  expected: unknown,
  out: Mismatch[],
): void {
  const values = getAtPath(body, parseJsonPath(path));
  if (values.length === 0) {
    out.push({
      path,
      kind: 'missing',
      expected,
      message: 'expected a value at path, but it is absent',
    });
    return;
  }
  const actual = values.length === 1 ? values[0] : values;
  if (!deepEqual(actual, expected)) {
    diffJson(expected, actual, path, out);
  }
}
