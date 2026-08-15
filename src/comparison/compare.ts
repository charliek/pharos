import type { HttpResponseRecord } from '../execution/http-client';
import { assertHeaderExpectations, type HeaderExpectations } from './expectations';
import { compareLocation, compareSetCookie, type DimensionResult } from './headers';
import { type DiffVocabulary, diffJson, renderMismatches } from './json-diff';
import { matchPathBetween, matchPathExpectation } from './matchers';
import { normalizeJson } from './normalize';
import {
  asciiLower,
  REDACTED,
  redactHeaderMismatches,
  redactHeaders,
  redactJsonValue,
} from './redaction';
import type { ComparisonResult, ComparisonStrategy, Mismatch } from './result';
import type { ComparisonRules } from './rules';
import { maskError, maskMismatches, maskText, maskValue, type SensitiveValues } from './sensitive';

/** Explicit expectations asserted against a single (new) response. */
export interface ExpectSpec extends HeaderExpectations {
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
  /** Query-parameter names to mask on top of the built-in secret-bearing ones. */
  sensitiveQueryParams?: string[];
  /**
   * Values extracted from secret-bearing sources during this scenario run (spec
   * Section 8.5). Masked out of every mismatch — and of the view a custom
   * comparator sees — no matter which field they were substituted into.
   */
  sensitive?: SensitiveValues;
  /**
   * The URL of the request that produced `legacy` — what a relative `Location`
   * resolves against (spec Section 8.6). Absent for a recorded response whose
   * request URL cannot be reconstructed.
   */
  legacyRequestUrl?: string;
  /** The URL of the request that produced `candidate`. */
  candidateRequestUrl?: string;
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
    const key = asciiLower(name);
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

/**
 * Which side vocabulary this request's diff should render with.
 *
 * `explicit_expectations` is expectation-sourced unconditionally: it never reads
 * `req.legacy`, so even in `compare_live` its `expected` values are the
 * scenario author's literals, not anything a legacy service sent.
 *
 * `custom` is the ambiguous one — it is the only other strategy
 * `new_only_assert` permits, and the scenario's *mode* never reaches `compare()`
 * (the step runner passes responses, not the mode). Rather than plumb the mode
 * down just to re-derive it, key on the honest signal already on the request:
 * a comparator handed no legacy response has no legacy side to have sourced an
 * `expected` value from, so whatever it asserts came from the comparator itself.
 * That is exactly the `new_only_assert` case — the two two-sided modes always
 * populate `legacy` before comparing (a legacy transport error short-circuits to
 * an execution failure and never reaches here).
 */
function vocabularyFor(req: CompareRequest): DiffVocabulary {
  if (req.strategy === 'explicit_expectations') return 'expectation';
  if (req.strategy === 'custom' && req.legacy === undefined) return 'expectation';
  return 'two_sided';
}

/**
 * Assemble the result. Extracted-secret masking (spec Section 8.5) runs here,
 * on the structured mismatches, **before** the diff text is rendered from them:
 * the renderer's bounded preview truncates, so masking afterwards could leave a
 * clipped prefix of a long token in the diff.
 */
function toResult(
  req: CompareRequest,
  mismatches: Mismatch[],
  truncated = false,
): ComparisonResult {
  const masked = maskMismatches(mismatches, req.sensitive);
  return {
    pass: masked.length === 0,
    summary: summarize(req.strategy, masked),
    mismatches: masked,
    diffText: masked.length > 0 ? renderMismatches(masked, vocabularyFor(req)) : undefined,
    ...(truncated ? { diffTruncated: true } : {}),
  };
}

/**
 * Run the two opt-in header dimensions (spec Section 8.6). Each is compared only
 * when some contract layer declared its block; each list is bounded, and a clip
 * on either sets the result's truncation flag. Returns whether anything was
 * clipped.
 */
function compareDimensions(
  req: CompareRequest,
  legacy: HttpResponseRecord,
  out: Mismatch[],
): boolean {
  const options = { sensitiveQueryParams: req.sensitiveQueryParams };
  const dimensions: DimensionResult[] = [];
  if (req.rules.set_cookie) {
    dimensions.push(
      compareSetCookie(req.rules.set_cookie, legacy.setCookie, req.candidate.setCookie, options),
    );
  }
  if (req.rules.location) {
    dimensions.push(
      compareLocation(
        req.rules.location,
        { headers: legacy.headers, requestUrl: req.legacyRequestUrl },
        { headers: req.candidate.headers, requestUrl: req.candidateRequestUrl },
        options,
      ),
    );
  }
  for (const dimension of dimensions) out.push(...dimension.mismatches);
  return dimensions.some((dimension) => dimension.truncated);
}

/**
 * Header names a custom comparator's view must never see raw, regardless of
 * what the scenario configured as `sensitiveHeaders` — mirrors
 * `reporting/artifacts.ts`'s `ALWAYS_REDACTED_HEADERS`. `set-cookie` carries
 * session secrets the cookie jar put on the wire; `cookie` would too if it
 * ever surfaced in a response. Unioned in rather than replacing the
 * configured list.
 */
const ALWAYS_REDACTED_COMPARATOR_HEADERS = ['set-cookie', 'cookie'];

/**
 * A redacted view of a response for a custom comparator: secret JSON paths and
 * sensitive headers are masked so a comparator cannot surface them into a
 * mismatch (and from there into a report). Extracted secret values are masked
 * here too, wherever in the response they appear — a comparator sees the same
 * masked view every other output surface does.
 */
function redactedView(
  response: HttpResponseRecord,
  rules: ComparisonRules,
  sensitiveHeaders: string[],
  sensitive: SensitiveValues | undefined,
): HttpResponseRecord {
  // Masked structurally, then re-serialized into `bodyText` below: masking the
  // serialized text instead would miss a value the encoder escaped.
  const bodyJson =
    response.bodyJson !== undefined
      ? maskValue(redactJsonValue(response.bodyJson, rules.json.redact_paths), sensitive)
      : undefined;
  // Set-Cookie values are secrets, so the comparator view masks every
  // captured entry unconditionally — a scenario's `sensitiveHeaders` config
  // must never be able to leave a custom comparator with a raw cookie value.
  // Attribute-level cookie redaction arrives separately with the set_cookie
  // comparison dimension (Section 8.6).
  const safeSensitiveHeaders = [
    ...new Set([...sensitiveHeaders, ...ALWAYS_REDACTED_COMPARATOR_HEADERS]),
  ];
  return {
    status: response.status,
    headers: maskValue(redactHeaders(response.headers, safeSensitiveHeaders), sensitive),
    setCookie: response.setCookie.map(() => REDACTED),
    bodyText:
      bodyJson !== undefined ? JSON.stringify(bodyJson) : maskText(response.bodyText, sensitive),
    bodyJson,
    durationMs: response.durationMs,
    ...(response.error ? { error: maskError(response.error, sensitive) } : {}),
  };
}

function runCustom(req: CompareRequest): ComparisonResult {
  if (!req.comparator) {
    throw new Error("strategy 'custom' requires a resolved comparator");
  }
  const sensitiveHeaders = req.sensitiveHeaders ?? [];
  const sensitive = req.sensitive;
  const result = req.comparator({
    legacy: req.legacy
      ? redactedView(req.legacy, req.rules, sensitiveHeaders, sensitive)
      : undefined,
    candidate: redactedView(req.candidate, req.rules, sensitiveHeaders, sensitive),
    rules: req.rules,
    args: req.comparatorArgs,
  });
  // Sanitize and re-derive output from the (possibly custom) mismatches so a
  // comparator cannot leak a secret header value through its own diffText.
  const raw = Array.isArray(result) ? result : result.mismatches;
  const mismatches = redactHeaderMismatches(raw, req.sensitiveHeaders ?? []);
  if (Array.isArray(result)) return toResult(req, mismatches);
  // A comparator that returned a whole result keeps its own summary — masked
  // like everything else, since a hand-written summary can embed a value.
  const masked = maskMismatches(mismatches, sensitive);
  return {
    ...result,
    summary: maskText(result.summary, sensitive),
    mismatches: masked,
    diffText: masked.length > 0 ? renderMismatches(masked, vocabularyFor(req)) : undefined,
  };
}

/** Compare two responses (or one against explicit expectations) per the strategy. */
export function compare(req: CompareRequest): ComparisonResult {
  if (req.strategy === 'custom') return runCustom(req);

  const mismatches: Mismatch[] = [];
  const wantStatus = req.rules.compare_status || req.statusSame === true;
  let truncated = false;

  switch (req.strategy) {
    case 'exact':
    case 'json_semantic': {
      const legacy = requireLegacy(req);
      if (wantStatus) compareStatus(legacy.status, req.candidate.status, mismatches);
      compareHeaders(legacy, req.candidate, req.rules.compare_headers, mismatches);
      truncated = compareDimensions(req, legacy, mismatches);
      compareBodies(legacy, req.candidate, req.rules, mismatches);
      break;
    }
    case 'subset': {
      const legacy = requireLegacy(req);
      if (wantStatus) compareStatus(legacy.status, req.candidate.status, mismatches);
      truncated = compareDimensions(req, legacy, mismatches);
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
      // Header / Set-Cookie / Location assertions reuse the Section 8.6 parsers
      // one-sided (spec Section 4.7).
      assertHeaderExpectations(
        expect,
        {
          headers: req.candidate.headers,
          setCookie: req.candidate.setCookie,
          requestUrl: req.candidateRequestUrl,
        },
        mismatches,
        { sensitiveQueryParams: req.sensitiveQueryParams },
      );
      break;
    }
  }

  return toResult(req, redactHeaderMismatches(mismatches, req.sensitiveHeaders ?? []), truncated);
}
