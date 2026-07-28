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

/**
 * ASCII-only lowercase — the fold every case-insensitive name match in the
 * comparison engine uses: cookie attribute names and `ignore_attributes` (spec
 * Section 8.6), header names, and the secret-bearing query-parameter names.
 *
 * Deliberately **not** `String.prototype.toLowerCase`, which is Unicode-aware:
 * it folds `İ` (U+0130) to `i̇` and `K` (U+212A) to `k`, while Limen's
 * `to_ascii_lowercase` / `eq_ignore_ascii_case` leave both untouched. Folding
 * beyond ASCII would make the two engines disagree about whether two attribute
 * names are the same name — a lockstep break the moment a non-ASCII name
 * appears — and it is not what HTTP's case-insensitivity means either.
 */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

/**
 * Query-parameter names whose values are always masked wherever a URL is
 * rendered, whatever the operator configured. Lowercase, and identical to
 * Limen's built-in set (Limen spec Section 7.5) so the two engines render the
 * same `Location` query safely: `code` is here because an OAuth authorization
 * code is a single-use credential that travels in a redirect `Location`.
 */
export const SENSITIVE_QUERY_PARAMS: readonly string[] = [
  'access_token',
  'token',
  'api_key',
  'apikey',
  'code',
];

/** ASCII-lowercased set for case-insensitive header/param matching. */
function lowerSet(names: string[]): Set<string> {
  return new Set(names.map(asciiLower));
}

/**
 * Mask an already-rendered query value when its parameter *name* marks it
 * secret-bearing — {@link SENSITIVE_QUERY_PARAMS} plus whatever the operator
 * configured. The single masking rule wherever a URL query reaches a mismatch:
 * the two-sided `location` dimension and the one-sided `expect` assertions both
 * render through it.
 */
export function maskQueryValue(
  name: string,
  rendered: string | undefined,
  extraSensitive: readonly string[] = [],
): string | undefined {
  if (rendered === undefined) return undefined;
  const param = asciiLower(name);
  const sensitive =
    SENSITIVE_QUERY_PARAMS.includes(param) ||
    extraSensitive.some((configured) => asciiLower(configured) === param);
  return sensitive ? REDACTED : rendered;
}

/** Mask the values of any header whose name is configured sensitive (case-insensitive). */
export function redactHeaders(
  headers: Record<string, string>,
  sensitive: string[],
): Record<string, string> {
  const target = lowerSet(sensitive);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = target.has(asciiLower(name)) ? REDACTED : value;
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
    if (target.has(asciiLower(key))) {
      parsed.searchParams.set(key, REDACTED);
      changed = true;
    }
  }
  if (!changed) return url;
  return isRelative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
}

export type QueryParams = Record<string, string | number | boolean | null>;

/** Mask the values of configured query parameters (case-insensitive names). */
export function redactQuery(
  query: QueryParams | undefined,
  sensitiveParams: string[],
): QueryParams | undefined {
  if (!query || sensitiveParams.length === 0) return query;
  const target = lowerSet(sensitiveParams);
  const out: QueryParams = {};
  for (const [key, value] of Object.entries(query)) {
    out[key] = target.has(asciiLower(key)) ? REDACTED : value;
  }
  return out;
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
    if (!target.has(asciiLower(name))) return mismatch;
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
