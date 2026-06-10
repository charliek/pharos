import type { HttpResponseRecord } from '../execution/http-client';
import { diffJson, renderMismatches } from './json-diff';
import { matchPathBetween, matchPathExpectation } from './matchers';
import { normalizeJson } from './normalize';
import { redactHeaderMismatches, redactHeaders, redactJsonValue } from './redaction';
import type { ComparisonResult, ComparisonStrategy, Mismatch } from './result';
import type { ComparisonRules } from './rules';

/** Explicit expectations asserted against a single (new) response. */
export interface ExpectSpec {
  status?: number;
  body?: { json_paths?: Record<string, unknown> };
}

export interface CustomComparatorContext {
  legacy?: HttpResponseRecord;
  candidate: HttpResponseRecord;
  rules: ComparisonRules;
  args?: unknown;
}

export type CustomComparator = (ctx: CustomComparatorContext) => ComparisonResult | Mismatch[];

export interface CompareRequest {
  strategy: ComparisonStrategy;
  rules: ComparisonRules;
  /** Legacy or recorded response — required for exact / json_semantic / subset. */
  legacy?: HttpResponseRecord;
  /** The new service's response, i.e. the thing under test. */
  candidate: HttpResponseRecord;
  /** Force status comparison even when rules.compare_status is false (inline `status: same`). */
  statusSame?: boolean;
  requireMatchingPaths?: string[];
  expect?: ExpectSpec;
  comparator?: CustomComparator;
  comparatorArgs?: unknown;
  /** Header names whose values must be masked in any mismatch (output safety). */
  sensitiveHeaders?: string[];
}

function requireLegacy(req: CompareRequest): HttpResponseRecord {
  if (!req.legacy) {
    throw new Error(
      `strategy '${req.strategy}' requires a legacy/recorded response to compare against`,
    );
  }
  return req.legacy;
}

function compareStatus(expected: number, actual: number, out: Mismatch[]): void {
  if (expected !== actual) {
    out.push({ path: '$.status', kind: 'status', expected, actual, message: 'status differs' });
  }
}

function compareHeaders(
  legacy: HttpResponseRecord,
  candidate: HttpResponseRecord,
  names: string[],
  out: Mismatch[],
): void {
  for (const name of names) {
    const key = name.toLowerCase();
    const expected = legacy.headers[key];
    const actual = candidate.headers[key];
    if (expected !== actual) {
      out.push({
        path: `headers.${key}`,
        kind: 'header',
        expected,
        actual,
        message: `header '${key}' differs`,
      });
    }
  }
}

function compareBodies(
  legacy: HttpResponseRecord,
  candidate: HttpResponseRecord,
  rules: ComparisonRules,
  out: Mismatch[],
): void {
  if (!rules.compare_body) return;
  if (legacy.bodyJson !== undefined && candidate.bodyJson !== undefined) {
    const normalizedLegacy = normalizeJson(legacy.bodyJson, rules.json);
    const normalizedCandidate = normalizeJson(candidate.bodyJson, rules.json);
    diffJson(normalizedLegacy, normalizedCandidate, '$', out);
    return;
  }
  // Plain-text fallback. The raw bodies are never embedded here (they could carry
  // unredacted secrets); they live in the redacted artifacts instead.
  if (legacy.bodyText !== candidate.bodyText) {
    out.push({
      path: '$',
      kind: 'body',
      message: 'response body differs (non-JSON, compared as text)',
    });
  }
}

function summarize(strategy: ComparisonStrategy, mismatches: Mismatch[]): string {
  return mismatches.length === 0
    ? `match (${strategy})`
    : `${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'} (${strategy})`;
}

function toResult(strategy: ComparisonStrategy, mismatches: Mismatch[]): ComparisonResult {
  return {
    pass: mismatches.length === 0,
    summary: summarize(strategy, mismatches),
    mismatches,
    diffText: mismatches.length > 0 ? renderMismatches(mismatches) : undefined,
  };
}

/**
 * A redacted view of a response for a custom comparator: secret JSON paths and
 * sensitive headers are masked so a comparator cannot surface them into a
 * mismatch (and from there into a report).
 */
function redactedView(
  response: HttpResponseRecord,
  rules: ComparisonRules,
  sensitiveHeaders: string[],
): HttpResponseRecord {
  const bodyJson =
    response.bodyJson !== undefined
      ? redactJsonValue(response.bodyJson, rules.json.redact_paths)
      : undefined;
  return {
    status: response.status,
    headers: redactHeaders(response.headers, sensitiveHeaders),
    bodyText: bodyJson !== undefined ? JSON.stringify(bodyJson) : response.bodyText,
    bodyJson,
    durationMs: response.durationMs,
    ...(response.error ? { error: response.error } : {}),
  };
}

function runCustom(req: CompareRequest): ComparisonResult {
  if (!req.comparator) {
    throw new Error("strategy 'custom' requires a resolved comparator");
  }
  const sensitiveHeaders = req.sensitiveHeaders ?? [];
  const result = req.comparator({
    legacy: req.legacy ? redactedView(req.legacy, req.rules, sensitiveHeaders) : undefined,
    candidate: redactedView(req.candidate, req.rules, sensitiveHeaders),
    rules: req.rules,
    args: req.comparatorArgs,
  });
  // Sanitize and re-derive output from the (possibly custom) mismatches so a
  // comparator cannot leak a secret header value through its own diffText.
  const raw = Array.isArray(result) ? result : result.mismatches;
  const mismatches = redactHeaderMismatches(raw, req.sensitiveHeaders ?? []);
  if (Array.isArray(result)) return toResult('custom', mismatches);
  return {
    ...result,
    mismatches,
    diffText: mismatches.length > 0 ? renderMismatches(mismatches) : undefined,
  };
}

/** Compare two responses (or one against explicit expectations) per the strategy. */
export function compare(req: CompareRequest): ComparisonResult {
  if (req.strategy === 'custom') return runCustom(req);

  const mismatches: Mismatch[] = [];
  const wantStatus = req.rules.compare_status || req.statusSame === true;

  switch (req.strategy) {
    case 'exact':
    case 'json_semantic': {
      const legacy = requireLegacy(req);
      if (wantStatus) compareStatus(legacy.status, req.candidate.status, mismatches);
      compareHeaders(legacy, req.candidate, req.rules.compare_headers, mismatches);
      compareBodies(legacy, req.candidate, req.rules, mismatches);
      break;
    }
    case 'subset': {
      const legacy = requireLegacy(req);
      if (wantStatus) compareStatus(legacy.status, req.candidate.status, mismatches);
      const normalizedLegacy =
        legacy.bodyJson !== undefined ? normalizeJson(legacy.bodyJson, req.rules.json) : undefined;
      const normalizedCandidate =
        req.candidate.bodyJson !== undefined
          ? normalizeJson(req.candidate.bodyJson, req.rules.json)
          : undefined;
      for (const path of req.requireMatchingPaths ?? []) {
        matchPathBetween(normalizedLegacy, normalizedCandidate, path, mismatches);
      }
      break;
    }
    case 'explicit_expectations': {
      const expect = req.expect;
      if (!expect) throw new Error("strategy 'explicit_expectations' requires an expect spec");
      if (expect.status !== undefined) {
        if (expect.status !== req.candidate.status) {
          mismatches.push({
            path: '$.status',
            kind: 'status',
            expected: expect.status,
            actual: req.candidate.status,
            message: 'status differs from expectation',
          });
        }
      }
      const jsonPaths = expect.body?.json_paths;
      if (jsonPaths) {
        // Literal assertions compare against the response *without* normalization
        // (so ignore_paths/timestamps don't defeat the assertion) — but redacted
        // paths are still masked, so a redacted value can never reach a mismatch.
        const body = redactJsonValue(req.candidate.bodyJson, req.rules.json.redact_paths);
        for (const [path, expectedValue] of Object.entries(jsonPaths)) {
          matchPathExpectation(body, path, expectedValue, mismatches);
        }
      }
      break;
    }
  }

  return toResult(req.strategy, redactHeaderMismatches(mismatches, req.sensitiveHeaders ?? []));
}
