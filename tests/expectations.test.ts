import { describe, expect, it } from 'vitest';
import { compare, type ExpectSpec } from '../src/comparison/compare';
import { REDACTED } from '../src/comparison/redaction';
import { neutralMismatchKinds } from '../src/comparison/result';
import { defaultComparisonRules } from '../src/comparison/rules';
import { type FieldIssue, ValidationError } from '../src/errors';
import type { HttpResponseRecord } from '../src/execution/http-client';
import { loadScenarioFromText } from '../src/scenarios/load';

/**
 * The one-sided `expect` assertion vocabulary (spec Section 4.7). Pharos-only —
 * it reuses the Section 8.6 parsers but pairs cookies by consumption rather than
 * positionally, since there is no second side to position against.
 */

function response(
  headers: Record<string, string> = {},
  setCookie: string[] = [],
  status = 200,
): HttpResponseRecord {
  return { status, headers, setCookie, bodyText: '', durationMs: 0 };
}

function assertExpect(
  expectSpec: ExpectSpec,
  candidate: HttpResponseRecord,
  requestUrl = 'https://new.example/start',
) {
  return compare({
    strategy: 'explicit_expectations',
    rules: defaultComparisonRules(),
    candidate,
    expect: expectSpec,
    candidateRequestUrl: requestUrl,
  });
}

function kinds(
  expectSpec: ExpectSpec,
  candidate: HttpResponseRecord,
  requestUrl?: string,
): string[] {
  return neutralMismatchKinds(assertExpect(expectSpec, candidate, requestUrl).mismatches);
}

describe('expect.headers / expect.header_absent', () => {
  it('asserts named single-value headers case-insensitively', () => {
    const candidate = response({ 'x-frame-options': 'DENY' });
    expect(kinds({ headers: { 'X-Frame-Options': 'DENY' } }, candidate)).toEqual([]);
    expect(kinds({ headers: { 'x-frame-options': 'SAMEORIGIN' } }, candidate)).toEqual(['header']);
    // A header the response never sent is a mismatch too.
    expect(kinds({ headers: { 'x-missing': 'x' } }, candidate)).toEqual(['header']);
  });

  it('asserts headers are absent', () => {
    const candidate = response({ 'x-forwarded-host': 'legacy.example' });
    expect(kinds({ header_absent: ['x-request-id'] }, candidate)).toEqual([]);
    expect(kinds({ header_absent: ['X-Forwarded-Host'] }, candidate)).toEqual(['header']);
  });
});

describe('expect.set_cookie', () => {
  const loginResponse = response({}, [
    'session=abc123; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=2592000',
    'theme=dark; Path=/',
  ]);

  it('asserts a cookie by name, value, and attributes', () => {
    expect(
      kinds(
        {
          set_cookie: [
            {
              name: 'session',
              value_present: true,
              attributes: { Path: '/', HttpOnly: true, SameSite: 'None', 'max-age': '2592000' },
            },
          ],
        },
        loginResponse,
      ),
    ).toEqual([]);
    // Attribute values are exact; names are case-insensitive.
    expect(
      kinds({ set_cookie: [{ name: 'session', attributes: { SameSite: 'Lax' } }] }, loginResponse),
    ).toEqual(['set_cookie.attribute']);
    // A boolean asserts a flag attribute's presence / absence.
    expect(
      kinds({ set_cookie: [{ name: 'theme', attributes: { HttpOnly: true } }] }, loginResponse),
    ).toEqual(['set_cookie.attribute']);
    expect(
      kinds({ set_cookie: [{ name: 'theme', attributes: { HttpOnly: false } }] }, loginResponse),
    ).toEqual([]);
  });

  it('reports an expected cookie the response never set', () => {
    expect(kinds({ set_cookie: [{ name: 'refresh' }] }, loginResponse)).toEqual([
      'set_cookie.presence',
    ]);
  });

  it('never renders a cookie value, expected or actual', () => {
    const result = assertExpect(
      { set_cookie: [{ name: 'session', value: 'expected-secret-value' }] },
      response({}, ['session=actual-secret-value; Path=/']),
    );
    expect(neutralMismatchKinds(result.mismatches)).toEqual(['set_cookie.value']);
    const rendered = `${JSON.stringify(result)}${result.diffText}`;
    expect(rendered).not.toContain('expected-secret-value');
    expect(rendered).not.toContain('actual-secret-value');
    expect(rendered).toContain(REDACTED);
  });

  it('fails value_present on an empty value', () => {
    expect(
      kinds({ set_cookie: [{ name: 'session', value_present: true }] }, response({}, ['session='])),
    ).toEqual(['set_cookie.value']);
  });

  it('consumes the first not-yet-consumed cookie of that name, in response order', () => {
    const flashes = response({}, ['flash=one; Path=/', 'flash=two; Path=/admin']);
    // Two expectations consume successive occurrences.
    expect(
      kinds(
        {
          set_cookie: [
            { name: 'flash', attributes: { Path: '/' } },
            { name: 'flash', attributes: { Path: '/admin' } },
          ],
        },
        flashes,
      ),
    ).toEqual([]);
    // Both expectations naming the same attributes cannot both consume the first.
    expect(
      kinds(
        {
          set_cookie: [
            { name: 'flash', attributes: { Path: '/' } },
            { name: 'flash', attributes: { Path: '/' } },
          ],
        },
        flashes,
      ),
    ).toEqual(['set_cookie.attribute']);
    // A third expectation runs out of response cookies to consume.
    expect(
      kinds({ set_cookie: [{ name: 'flash' }, { name: 'flash' }, { name: 'flash' }] }, flashes),
    ).toEqual(['set_cookie.presence']);
  });

  it('leaves unconsumed response cookies alone (assertions are not exhaustive)', () => {
    expect(kinds({ set_cookie: [{ name: 'theme' }] }, loginResponse)).toEqual([]);
  });

  it('exact_attributes promotes the listed map to the whole attribute set', () => {
    const candidate = response({}, ['sid=a; Path=/; HttpOnly']);
    expect(kinds({ set_cookie: [{ name: 'sid', attributes: { Path: '/' } }] }, candidate)).toEqual(
      [],
    );
    expect(
      kinds(
        { set_cookie: [{ name: 'sid', attributes: { Path: '/' }, exact_attributes: true }] },
        candidate,
      ),
    ).toEqual(['set_cookie.attribute']);
    expect(
      kinds(
        {
          set_cookie: [
            { name: 'sid', attributes: { Path: '/', HttpOnly: true }, exact_attributes: true },
          ],
        },
        candidate,
      ),
    ).toEqual([]);
  });
});

describe('expect.location', () => {
  const redirect = response({ location: '/login?error=access_denied&return_to=%2Fhome' }, [], 303);

  it('resolves a relative Location against the request URL and asserts parts', () => {
    expect(
      kinds(
        {
          location: {
            path: '/login',
            query: { error: 'access_denied' },
            query_present: ['return_to'],
            query_absent: ['client_secret'],
          },
        },
        redirect,
      ),
    ).toEqual([]);
  });

  it('reports each asserted part that differs', () => {
    expect(kinds({ location: { path: '/other' } }, redirect)).toEqual(['location.path']);
    expect(kinds({ location: { query: { error: 'nope' } } }, redirect)).toEqual(['location.query']);
    expect(kinds({ location: { query_present: ['state'] } }, redirect)).toEqual(['location.query']);
    expect(kinds({ location: { query_absent: ['return_to'] } }, redirect)).toEqual([
      'location.query',
    ]);
  });

  it('reports a missing Location as a presence mismatch', () => {
    expect(kinds({ location: { path: '/login' } }, response())).toEqual(['location.presence']);
  });

  it('reports an unresolvable Location without rendering it', () => {
    // No request URL at all (a step whose path did not resolve), so the relative
    // Location cannot be resolved and takes the exact-string fallback.
    const result = compare({
      strategy: 'explicit_expectations',
      rules: defaultComparisonRules(),
      candidate: redirect,
      expect: { location: { path: '/login' } },
    });
    expect(neutralMismatchKinds(result.mismatches)).toEqual(['location.raw']);
    expect(result.mismatches[0].actual).toBe(REDACTED);
  });

  it('masks a secret-bearing query value on both sides', () => {
    const result = assertExpect(
      { location: { query: { code: 'expected-auth-code' } } },
      response({ location: 'https://app.example/cb?code=actual-auth-code' }),
    );
    const rendered = `${JSON.stringify(result)}${result.diffText}`;
    expect(rendered).not.toContain('expected-auth-code');
    expect(rendered).not.toContain('actual-auth-code');
  });

  it('masks operator-configured query params too, like the two-sided path', () => {
    const result = compare({
      strategy: 'explicit_expectations',
      rules: defaultComparisonRules(),
      candidate: response({ location: 'https://app.example/cb?session_hint=actual-hint-value' }),
      expect: { location: { query: { session_hint: 'expected-hint-value' } } },
      candidateRequestUrl: 'https://new.example/start',
      // The operator's configured list reaches the one-sided assertions too.
      sensitiveQueryParams: ['Session_Hint'],
    });
    const rendered = `${JSON.stringify(result)}${result.diffText}`;
    expect(neutralMismatchKinds(result.mismatches)).toEqual(['location.query']);
    expect(rendered).not.toContain('expected-hint-value');
    expect(rendered).not.toContain('actual-hint-value');
    expect(rendered).toContain(REDACTED);
  });
});

// --- Load-time validation ---------------------------------------------------

function issuesOf(yaml: string): FieldIssue[] {
  try {
    loadScenarioFromText(yaml, 'scenario.yaml');
    return [];
  } catch (error) {
    if (error instanceof ValidationError) return error.issues;
    throw error;
  }
}

/** A `new_only_assert` scenario whose `expect` block is the given YAML lines. */
function scenarioWithExpect(...lines: string[]): string {
  return `
version: 1
id: auth.login
name: Login
service: auth
tags: [write]
mode: new_only_assert
steps:
  - id: login
    request: { method: POST, path: /login }
    compare:
      strategy: explicit_expectations
      expect:
${lines.map((line) => `        ${line}`).join('\n')}
`;
}

describe('expect vocabulary validation', () => {
  it('accepts the full vocabulary', () => {
    expect(
      issuesOf(
        scenarioWithExpect(
          'status: 303',
          'headers: { x-frame-options: DENY }',
          'header_absent: [x-forwarded-host]',
          'set_cookie:',
          '  - name: session',
          '    value_present: true',
          '    attributes: { Path: /, HttpOnly: true }',
          'location:',
          '  path: /login',
          '  query: { error: access_denied }',
        ),
      ),
    ).toEqual([]);
  });

  it('rejects naming set-cookie or cookie in headers / header_absent', () => {
    expect(issuesOf(scenarioWithExpect('headers: { Set-Cookie: x }'))[0]).toMatchObject({
      path: 'steps[0].compare.expect.headers.Set-Cookie',
    });
    expect(issuesOf(scenarioWithExpect('header_absent: [cookie]'))[0]).toMatchObject({
      path: 'steps[0].compare.expect.header_absent[0]',
    });
  });

  it('rejects a cookie expectation asserting both value and value_present', () => {
    const issues = issuesOf(
      scenarioWithExpect(
        'set_cookie:',
        '  - name: session',
        '    value: abc',
        '    value_present: true',
      ),
    );
    expect(issues[0].path).toBe('steps[0].compare.expect.set_cookie[0].value_present');
    // Field *presence*, not truthiness: `value_present: false` beside a value is
    // the same confused intent, and must not slip through.
    const withFalse = issuesOf(
      scenarioWithExpect(
        'set_cookie:',
        '  - name: session',
        '    value: abc',
        '    value_present: false',
      ),
    );
    expect(withFalse[0].path).toBe('steps[0].compare.expect.set_cookie[0].value_present');
  });

  it('accepts a header-only expectation as a sufficient assertion', () => {
    expect(issuesOf(scenarioWithExpect('header_absent: [x-request-id]'))).toEqual([]);
    expect(issuesOf(scenarioWithExpect('{}'))[0].path).toBe('steps[0].compare.expect');
  });
});
