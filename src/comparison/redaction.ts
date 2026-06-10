import { parseJsonPath, transformAtPath } from './jsonpath';
import type { Mismatch } from './result';

/**
 * Redaction (spec Section 8.5): the load-bearing guarantee that no secret value
 * appears in any output surface — console, JSON/JUnit reports, failure
 * artifacts, recordings. Body JSON-path redaction also runs during normalization
 * (so secrets never reach a diff); these helpers cover headers, query params,
 * and ad-hoc body redaction for the output surfaces.
 */

export const REDACTED = '***REDACTED***';

/** Lowercased set for case-insensitive header/param matching. */
function lowerSet(names: string[]): Set<string> {
  return new Set(names.map((name) => name.toLowerCase()));
}

/** Mask the values of any header whose name is configured sensitive (case-insensitive). */
export function redactHeaders(
  headers: Record<string, string>,
  sensitive: string[],
): Record<string, string> {
  const target = lowerSet(sensitive);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = target.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

/**
 * Mask configured query parameters in a URL or path string (case-insensitive
 * parameter names). Works for both absolute URLs and relative request paths
 * (e.g. `/users?access_token=secret`), preserving the original form.
 */
export function redactUrl(url: string, sensitiveParams: string[]): string {
  if (sensitiveParams.length === 0) return url;
  const target = lowerSet(sensitiveParams);
  const isRelative = !/^[a-z][a-z0-9+.-]*:/i.test(url);
  let parsed: URL;
  try {
    parsed = new URL(url, isRelative ? 'http://pharos.invalid' : undefined);
  } catch {
    return url;
  }
  let changed = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (target.has(key.toLowerCase())) {
      parsed.searchParams.set(key, REDACTED);
      changed = true;
    }
  }
  if (!changed) return url;
  return isRelative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
}

/**
 * Mask the values of header mismatches whose header name is configured sensitive.
 * A defensive output-safety pass over comparison results so that even a
 * misconfigured `compare_headers` (or a custom comparator) cannot leak a secret
 * header value into a diff. Body values are already masked during normalization.
 */
export function redactHeaderMismatches(mismatches: Mismatch[], sensitive: string[]): Mismatch[] {
  if (sensitive.length === 0) return mismatches;
  const target = lowerSet(sensitive);
  return mismatches.map((mismatch) => {
    if (mismatch.kind !== 'header') return mismatch;
    const name = mismatch.path.startsWith('headers.')
      ? mismatch.path.slice('headers.'.length)
      : mismatch.path;
    if (!target.has(name.toLowerCase())) return mismatch;
    return {
      ...mismatch,
      expected: mismatch.expected === undefined ? undefined : REDACTED,
      actual: mismatch.actual === undefined ? undefined : REDACTED,
    };
  });
}

/**
 * Return a deep clone of `value` with the configured JSON paths masked. Used for
 * output surfaces (artifacts/recordings) where a body should be redacted even if
 * the contract did not normalize it.
 */
export function redactJsonValue(value: unknown, paths: string[]): unknown {
  if (paths.length === 0) return value;
  const clone = structuredClone(value);
  for (const path of paths) {
    transformAtPath(clone, parseJsonPath(path), () => REDACTED);
  }
  return clone;
}
