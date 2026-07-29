import { z } from 'zod';
import {
  collectCookies,
  EMPTY,
  headerValue,
  locateUrl,
  type ParsedCookie,
  PRESENT,
  queryMap,
  renderCookieValue,
} from './headers';
import { asciiLower, maskQueryValue, REDACTED } from './redaction';
import type { Mismatch } from './result';

/**
 * The one-sided `expect` assertion vocabulary (spec Section 4.7): present/absent
 * headers, present/absent `Set-Cookie` entries, and `Location`, asserted against
 * a single (new) response.
 *
 * These reuse the **same** parsers as the two-sided `set_cookie`/`location`
 * comparison dimensions (Section 8.6) — one implementation, two consumers.
 * Unlike those, this vocabulary is Pharos-only (Limen never asserts one-sided)
 * and carries no lockstep obligation; only the parsing semantics are shared.
 * The pairing rule differs deliberately: an expected cookie consumes the
 * **first not-yet-consumed** response cookie of that name, in response order,
 * because there is no second side to position against.
 */

/** An expected attribute value: a literal, or `true`/`false` for a flag's presence. */
const expectedAttributeSchema = z.union([z.string(), z.number(), z.boolean()]);
export type ExpectedAttribute = z.infer<typeof expectedAttributeSchema>;

/**
 * One expected cookie, matched by `name` against the response's lossless
 * `setCookie` capture. The schema lives here, beside the code that consumes it,
 * so the scenario loader and the assertion engine cannot drift apart.
 */
export const expectedCookieSchema = z
  .object({
    name: z.string().min(1),
    /** Exact expected value — still never rendered into a mismatch. */
    value: z.string().optional(),
    /** Assert the value is non-empty without comparing it. */
    value_present: z.boolean().optional(),
    attributes: z.record(expectedAttributeSchema).optional(),
    /** When true, the cookie's full attribute set must equal `attributes`. */
    exact_attributes: z.boolean().optional(),
  })
  .strict();
export type ExpectedCookie = z.infer<typeof expectedCookieSchema>;

export const expectedLocationSchema = z
  .object({
    path: z.string().optional(),
    query: z.record(z.string()).optional(),
    query_present: z.array(z.string()).optional(),
    query_absent: z.array(z.string()).optional(),
  })
  .strict();
export type ExpectedLocation = z.infer<typeof expectedLocationSchema>;

export interface HeaderExpectations {
  headers?: Record<string, string>;
  header_absent?: string[];
  header_present?: string[];
  set_cookie?: ExpectedCookie[];
  set_cookie_absent?: string[];
  location?: ExpectedLocation;
}

export interface ResponseUnderTest {
  headers: Record<string, string>;
  setCookie: string[];
  /** The URL of the request that produced this response (relative-Location resolution). */
  requestUrl?: string;
}

export interface ExpectationOptions {
  /**
   * Query-parameter names to mask on top of the built-in secret-bearing ones —
   * the operator's configured list, the same one the two-sided `location`
   * dimension masks with, so a parameter declared secret is secret on both
   * paths.
   */
  sensitiveQueryParams?: string[];
}

/** Assert exact values for named single-value headers (case-insensitive names). */
function assertHeaders(
  expected: Record<string, string>,
  response: ResponseUnderTest,
  out: Mismatch[],
): void {
  for (const [name, value] of Object.entries(expected)) {
    const actual = headerValue(response.headers, name);
    if (actual === value) continue;
    out.push({
      path: `headers.${asciiLower(name)}`,
      kind: 'header',
      expected: value,
      actual,
      message: `header '${asciiLower(name)}' differs from expectation`,
    });
  }
}

/** Assert named headers are absent from the response. */
function assertHeadersAbsent(names: string[], response: ResponseUnderTest, out: Mismatch[]): void {
  for (const name of names) {
    const actual = headerValue(response.headers, name);
    if (actual === undefined) continue;
    out.push({
      path: `headers.${asciiLower(name)}`,
      kind: 'header',
      actual,
      message: `header '${asciiLower(name)}' must be absent`,
    });
  }
}

/**
 * Assert named headers are present with **any** non-empty value — for a header
 * whose exact value is inherently dynamic (e.g. `Retry-After`), only presence
 * is meaningful. Reports the same `header` kind `headers` uses.
 */
function assertHeadersPresent(names: string[], response: ResponseUnderTest, out: Mismatch[]): void {
  for (const name of names) {
    const actual = headerValue(response.headers, name);
    if (actual !== undefined && actual !== '') continue;
    out.push({
      path: `headers.${asciiLower(name)}`,
      kind: 'header',
      expected: PRESENT,
      actual: actual === undefined ? undefined : EMPTY,
      message: `header '${asciiLower(name)}' must be present with a non-empty value`,
    });
  }
}

/**
 * Assert no `Set-Cookie` entry with these names exists on the response —
 * presence only, independent of any `set_cookie` block's consume-and-pair
 * bookkeeping on the same step.
 */
function assertCookiesAbsent(names: string[], response: ResponseUnderTest, out: Mismatch[]): void {
  const { cookies } = collectCookies(response.setCookie);
  const present = new Set(cookies.map((cookie) => cookie.name));
  for (const name of names) {
    if (!present.has(name)) continue;
    out.push({
      path: `set_cookie.${name}`,
      kind: 'set_cookie.presence',
      actual: PRESENT,
      message: `cookie '${name}' must not be set`,
    });
  }
}

/** Whether an expected attribute value matches the cookie's actual attribute. */
function attributeMatches(
  expected: ExpectedAttribute,
  actual: { value: string } | undefined,
): boolean {
  // A boolean asserts the flag attribute's presence/absence; anything else is
  // compared exactly against the attribute's value.
  if (expected === true) return actual !== undefined;
  if (expected === false) return actual === undefined;
  return actual !== undefined && actual.value === String(expected);
}

function assertCookieAttributes(
  expected: ExpectedCookie,
  cookie: ParsedCookie,
  out: Mismatch[],
): void {
  const attributes = expected.attributes ?? {};
  for (const [name, value] of Object.entries(attributes)) {
    const actual = cookie.attributes.get(asciiLower(name));
    if (attributeMatches(value, actual)) continue;
    out.push({
      path: `set_cookie.${expected.name}.${name}`,
      kind: 'set_cookie.attribute',
      expected: value,
      actual: actual?.value,
      message: `cookie '${expected.name}' attribute '${name}' differs from expectation`,
    });
  }
  if (!expected.exact_attributes) return;
  // `exact_attributes` promotes the listed map from a subset to the whole set.
  const listed = new Set(Object.keys(attributes).map(asciiLower));
  for (const [key, attribute] of cookie.attributes) {
    if (listed.has(key)) continue;
    out.push({
      path: `set_cookie.${expected.name}.${attribute.name}`,
      kind: 'set_cookie.attribute',
      actual: attribute.value,
      message: `cookie '${expected.name}' has unexpected attribute '${attribute.name}' (exact_attributes: true)`,
    });
  }
}

/**
 * Assert expected cookies against the response's lossless `setCookie` capture.
 * Each expectation consumes the first not-yet-consumed response cookie with that
 * name; response cookies no expectation consumed are not an error.
 */
function assertCookies(
  expected: ExpectedCookie[],
  response: ResponseUnderTest,
  out: Mismatch[],
): void {
  const { cookies } = collectCookies(response.setCookie);
  const consumed = new Set<number>();

  for (const want of expected) {
    const index = cookies.findIndex((cookie, at) => !consumed.has(at) && cookie.name === want.name);
    if (index < 0) {
      out.push({
        path: `set_cookie.${want.name}`,
        kind: 'set_cookie.presence',
        expected: PRESENT,
        message: `expected cookie '${want.name}' was not set`,
      });
      continue;
    }
    consumed.add(index);
    const cookie = cookies[index];
    if (want.value !== undefined && cookie.value !== want.value) {
      out.push({
        path: `set_cookie.${want.name}`,
        kind: 'set_cookie.value',
        // The expected value is authored in the scenario but may still be a
        // secret, so neither side is ever rendered.
        expected: REDACTED,
        actual: renderCookieValue(cookie.value),
        message: `cookie '${want.name}' value differs from expectation`,
      });
    }
    if (want.value_present && cookie.value === '') {
      out.push({
        path: `set_cookie.${want.name}`,
        kind: 'set_cookie.value',
        expected: PRESENT,
        actual: renderCookieValue(cookie.value),
        message: `cookie '${want.name}' was expected to carry a value`,
      });
    }
    assertCookieAttributes(want, cookie, out);
  }
}

/** Assert parts of the response's `Location`; omitted parts are don't-care. */
function assertLocation(
  expected: ExpectedLocation,
  response: ResponseUnderTest,
  out: Mismatch[],
  options: ExpectationOptions,
): void {
  const located = locateUrl(response.headers, response.requestUrl);
  if (!located.url) {
    out.push({
      path: 'location',
      kind: located.raw === undefined ? 'location.presence' : 'location.raw',
      actual: located.raw === undefined ? undefined : REDACTED,
      message:
        located.raw === undefined
          ? 'expected a Location header, none was sent'
          : 'Location could not be resolved to a URL',
    });
    return;
  }
  const url = located.url;
  if (expected.path !== undefined && url.pathname !== expected.path) {
    out.push({
      path: 'location.path',
      kind: 'location.path',
      expected: expected.path,
      actual: url.pathname,
      message: 'Location path differs from expectation',
    });
  }
  // Nothing is ignored one-sided, so the full query participates. Rendering
  // reuses the two-sided masking rule: a secret-bearing parameter name (`code`,
  // `access_token`, …) is never rendered, on either side.
  const query = queryMap(url, []);
  for (const [name, value] of Object.entries(expected.query ?? {})) {
    const actual = query.get(name);
    if (actual?.includes(value)) continue;
    out.push({
      path: `location.query.${name}`,
      kind: 'location.query',
      expected: maskQueryValue(name, value, options.sensitiveQueryParams),
      actual: maskQueryValue(name, actual?.join(','), options.sensitiveQueryParams),
      message: `Location query param '${name}' differs from expectation`,
    });
  }
  for (const name of expected.query_present ?? []) {
    if (query.has(name)) continue;
    out.push({
      path: `location.query.${name}`,
      kind: 'location.query',
      message: `Location query param '${name}' is missing`,
    });
  }
  for (const name of expected.query_absent ?? []) {
    if (!query.has(name)) continue;
    out.push({
      path: `location.query.${name}`,
      kind: 'location.query',
      message: `Location query param '${name}' must be absent`,
    });
  }
}

/** Run every declared header/cookie/Location expectation against the response. */
export function assertHeaderExpectations(
  expect: HeaderExpectations,
  response: ResponseUnderTest,
  out: Mismatch[],
  options: ExpectationOptions = {},
): void {
  if (expect.headers) assertHeaders(expect.headers, response, out);
  if (expect.header_absent) assertHeadersAbsent(expect.header_absent, response, out);
  if (expect.header_present) assertHeadersPresent(expect.header_present, response, out);
  if (expect.set_cookie) assertCookies(expect.set_cookie, response, out);
  if (expect.set_cookie_absent) assertCookiesAbsent(expect.set_cookie_absent, response, out);
  if (expect.location) assertLocation(expect.location, response, out, options);
}
