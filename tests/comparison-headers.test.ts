import { describe, expect, it } from 'vitest';
import { compare } from '../src/comparison/compare';
import { MAX_DIFFERENCES } from '../src/comparison/headers';
import { REDACTED } from '../src/comparison/redaction';
import { neutralMismatchKinds } from '../src/comparison/result';
import {
  type ComparisonRules,
  defaultComparisonRules,
  defaultLocationRules,
  defaultSetCookieRules,
  type LocationRules,
  type SetCookieRules,
} from '../src/comparison/rules';
import type { HttpResponseRecord } from '../src/execution/http-client';

/**
 * The Set-Cookie / Location comparison dimensions (spec Section 8.6). The
 * cross-engine verdicts live in `lockstep.test.ts` and nothing here restates
 * one: these pin what the shared table cannot — bounds, rendering and
 * redaction, userinfo, effective ports, and the parsing edges it only samples.
 */

function response(
  headers: Record<string, string> = {},
  setCookie: string[] = [],
): HttpResponseRecord {
  return { status: 200, headers, setCookie, bodyText: '', durationMs: 0 };
}

function cookieRules(patch: Partial<SetCookieRules> = {}): ComparisonRules {
  return { ...defaultComparisonRules(), set_cookie: { ...defaultSetCookieRules(), ...patch } };
}

function locationRules(patch: Partial<LocationRules> = {}): ComparisonRules {
  return { ...defaultComparisonRules(), location: { ...defaultLocationRules(), ...patch } };
}

/** Compare two cookie-bearing responses and return the neutral mismatch kinds. */
function cookieKinds(rules: ComparisonRules, legacy: string[], candidate: string[]): string[] {
  return neutralMismatchKinds(
    compare({
      strategy: 'json_semantic',
      rules,
      legacy: response({}, legacy),
      candidate: response({}, candidate),
    }).mismatches,
  );
}

/** Compare two Location-bearing responses (each with its own request URL). */
function locationResult(
  rules: ComparisonRules,
  legacy: string | undefined,
  candidate: string | undefined,
  urls: { legacy?: string; candidate?: string } = {
    legacy: 'https://legacy.example/start',
    candidate: 'https://new.example/start',
  },
) {
  return compare({
    strategy: 'json_semantic',
    rules,
    legacy: response(legacy === undefined ? {} : { location: legacy }),
    candidate: response(candidate === undefined ? {} : { location: candidate }),
    legacyRequestUrl: urls.legacy,
    candidateRequestUrl: urls.candidate,
  });
}

function locationKinds(
  rules: ComparisonRules,
  legacy: string | undefined,
  candidate: string | undefined,
  urls?: { legacy?: string; candidate?: string },
): string[] {
  return neutralMismatchKinds(locationResult(rules, legacy, candidate, urls).mismatches);
}

describe('set_cookie dimension', () => {
  it('compares every Set-Cookie value, not just the last', () => {
    const legacy = ['sid=abc; Path=/', 'theme=dark; Path=/', 'region=us; Path=/'];
    expect(cookieKinds(cookieRules(), legacy, [...legacy])).toEqual([]);
    expect(cookieKinds(cookieRules(), legacy, ['sid=abc; Path=/', 'theme=light; Path=/'])).toEqual([
      'set_cookie.presence',
      'set_cookie.value',
    ]);
  });

  it('compares attribute names case-insensitively and attribute values exactly', () => {
    expect(cookieKinds(cookieRules(), ['sid=a; httponly'], ['sid=a; HttpOnly'])).toEqual([]);
    expect(cookieKinds(cookieRules(), ['sid=a; SameSite=Lax'], ['sid=a; SameSite=lax'])).toEqual([
      'set_cookie.attribute',
    ]);
  });

  it('folds attribute names ASCII-only, as Limen does', () => {
    // `İ` (U+0130) lowercases to `i̇` under Unicode but is untouched by an ASCII
    // fold — Limen's `to_ascii_lowercase` rule. Folding it here would make the
    // two engines disagree about whether two attribute names are one name.
    expect(cookieKinds(cookieRules(), ['sid=a; Xİ=1'], ['sid=a; Xİ=1'])).toEqual([]);
    // The two spellings differ only by that character's case, so an ASCII fold
    // keeps them distinct: each side carries an attribute the other lacks.
    expect(cookieKinds(cookieRules(), ['sid=a; Xİ=1'], ['sid=a; Xi̇=1'])).toEqual([
      'set_cookie.attribute',
    ]);
    // `ignore_attributes` folds identically, so it cannot ignore across the fold…
    expect(
      cookieKinds(cookieRules({ ignore_attributes: ['xi̇'] }), ['sid=a; Xİ=1'], ['sid=a; Xİ=2']),
    ).toEqual(['set_cookie.attribute']);
    // …while the ASCII part of the same name still folds, which is the rule.
    expect(
      cookieKinds(cookieRules({ ignore_attributes: ['xİ'] }), ['sid=a; Xİ=1'], ['sid=a; Xİ=2']),
    ).toEqual([]);
  });

  it('reports an attribute only one side sets', () => {
    const result = compare({
      strategy: 'json_semantic',
      rules: cookieRules(),
      legacy: response({}, ['sid=a; Path=/; Secure']),
      candidate: response({}, ['sid=a; Path=/']),
    });
    const mismatch = result.mismatches[0];
    expect(mismatch.kind).toBe('set_cookie.attribute');
    expect(mismatch.path).toBe('set_cookie.sid.Secure');
    expect(mismatch.actual).toBeUndefined();
  });

  it('keeps the last occurrence of a duplicated attribute (RFC 6265 5.2)', () => {
    // Legacy's effective Path is /b, so a new side setting /b matches.
    expect(cookieKinds(cookieRules(), ['sid=a; Path=/x; Path=/b'], ['sid=a; Path=/b'])).toEqual([]);
  });

  it('compares attributes around an empty value in presence mode', () => {
    const rules = cookieRules({ compare_values: 'presence' });
    expect(cookieKinds(rules, ['sid=; Path=/'], ['sid=; Path=/admin'])).toEqual([
      'set_cookie.attribute',
    ]);
  });

  it('leaves an unpaired duplicate-name cookie as a presence mismatch', () => {
    const legacy = ['flash=one; Path=/', 'flash=two; Path=/admin'];
    expect(cookieKinds(cookieRules(), legacy, [legacy[0]])).toEqual(['set_cookie.presence']);
  });

  it('treats an empty cookie name as malformed, like a missing `=`', () => {
    // The two shapes RFC 6265 5.2 discards; both take the exact-string fallback.
    expect(cookieKinds(cookieRules(), ['=novalue'], ['=novalue'])).toEqual([]);
    expect(cookieKinds(cookieRules(), ['=one'], ['=two'])).toEqual(['set_cookie.malformed']);
  });

  it('pairs malformed entries with each other, never with parsed cookies', () => {
    expect(
      cookieKinds(cookieRules(), ['sid=a; Path=/', 'broken'], ['broken', 'sid=a; Path=/']),
    ).toEqual([]);
  });

  it('bounds the mismatch list and flags truncation', () => {
    const legacy = Array.from({ length: MAX_DIFFERENCES + 5 }, (_, i) => `c${i}=legacy-${i}`);
    const candidate = legacy.map((entry, i) => entry.replace(`legacy-${i}`, `new-${i}`));
    const result = compare({
      strategy: 'json_semantic',
      rules: cookieRules(),
      legacy: response({}, legacy),
      candidate: response({}, candidate),
    });
    expect(result.mismatches).toHaveLength(MAX_DIFFERENCES);
    expect(result.diffTruncated).toBe(true);
  });

  it('never renders a cookie value, in any mismatch shape', () => {
    const result = compare({
      strategy: 'json_semantic',
      rules: cookieRules(),
      legacy: response({}, [
        'sid=super-secret-legacy; Path=/; SameSite=Lax',
        'gone=deleted-legacy-value; Path=/',
        'empty=; Path=/',
        'broken-legacy-entry',
      ]),
      candidate: response({}, [
        'sid=super-secret-new; Path=/; SameSite=None',
        'empty=filled-in-new-value; Path=/',
        'broken-new-entry',
      ]),
    });
    expect(result.pass).toBe(false);
    const rendered = `${JSON.stringify(result)}${result.diffText}`;
    for (const secret of [
      'super-secret-legacy',
      'super-secret-new',
      'deleted-legacy-value',
      'filled-in-new-value',
      'broken-legacy-entry',
      'broken-new-entry',
    ]) {
      expect(rendered).not.toContain(secret);
    }
    // The names and attribute values that explain the diff are still there.
    expect(rendered).toContain('sid');
    expect(rendered).toContain('SameSite');
    expect(rendered).toContain('Lax');
    expect(rendered).toContain(REDACTED);
  });
});

describe('location dimension', () => {
  it('resolves each side against its OWN request URL', () => {
    // Two relative Locations that look identical resolve to two different hosts.
    expect(locationKinds(locationRules(), '/next?x=1', '/next?x=1')).toEqual(['location.origin']);
  });

  it('falls back to exact strings when a Location cannot be resolved', () => {
    const noBase = { legacy: undefined, candidate: undefined };
    expect(locationKinds(locationRules(), '/next', '/next', noBase)).toEqual([]);
    const result = locationResult(locationRules(), '/next', '/other', noBase);
    expect(neutralMismatchKinds(result.mismatches)).toEqual(['location.raw']);
    // An unparseable value cannot be masked selectively, so neither side renders.
    expect(result.mismatches[0].expected).toBe(REDACTED);
    expect(result.mismatches[0].actual).toBe(REDACTED);
  });

  it('matches ignore_query_params case-sensitively', () => {
    // `State` is not the ignored `state`.
    expect(
      locationKinds(
        locationRules({ ignore_query_params: ['state', 'nonce'] }),
        'https://app.example/cb?State=legacy',
        'https://app.example/cb?State=new',
      ),
    ).toEqual(['location.query']);
  });

  it('compares a repeated query name as an ordered list of values', () => {
    expect(
      locationKinds(
        locationRules(),
        'https://app.example/n?a=1&a=2',
        'https://app.example/n?a=2&a=1',
      ),
    ).toEqual(['location.query']);
  });

  it('compares the (scheme, host, effective port) triple, not URL.origin', () => {
    const rules = locationRules({ origin: 'exact' });
    // `URL.origin` is the string "null" for a non-special scheme, which would
    // make two identical mailto: Locations mismatch as opaque origins.
    expect(locationKinds(rules, 'mailto:ops@example.com', 'mailto:ops@example.com')).toEqual([]);
    expect(locationKinds(rules, 'mailto:ops@example.com', 'mailto:other@example.com')).toEqual([
      'location.path',
    ]);
    // Effective port: an explicit default port is the same origin as none.
    expect(locationKinds(rules, 'https://a.example/x', 'https://a.example:443/x')).toEqual([]);
    expect(locationKinds(rules, 'https://a.example/x', 'https://a.example:8443/x')).toEqual([
      'location.origin',
    ]);
    expect(locationKinds(rules, 'https://a.example/x', 'http://a.example/x')).toEqual([
      'location.origin',
    ]);
  });

  it('never compares the fragment or the userinfo', () => {
    expect(
      locationKinds(
        locationRules(),
        'https://app.example/next#legacy-anchor',
        'https://app.example/next#new-anchor',
      ),
    ).toEqual([]);
    expect(
      locationKinds(
        locationRules(),
        'https://legacy-user:legacy-pass@app.example/next',
        'https://new-user:new-pass@app.example/next',
      ),
    ).toEqual([]);
  });

  it('renders a one-sided Location as origin + path, never its userinfo or query', () => {
    const result = locationResult(
      locationRules(),
      'https://user:hunter2-secret@app.example/next?access_token=super-secret-token',
      undefined,
    );
    expect(neutralMismatchKinds(result.mismatches)).toEqual(['location.presence']);
    const rendered = `${JSON.stringify(result)}${result.diffText}`;
    expect(rendered).toContain('https://app.example:443/next');
    expect(rendered).not.toContain('hunter2-secret');
    expect(rendered).not.toContain('super-secret-token');
  });

  it('masks secret-bearing query values, including the OAuth code', () => {
    const result = locationResult(
      locationRules(),
      'https://app.example/cb?code=legacy-auth-code&tab=main',
      'https://app.example/cb?code=new-auth-code&tab=side',
    );
    expect(neutralMismatchKinds(result.mismatches)).toEqual(['location.query']);
    const rendered = `${JSON.stringify(result)}${result.diffText}`;
    expect(rendered).not.toContain('legacy-auth-code');
    expect(rendered).not.toContain('new-auth-code');
    // A non-secret parameter is still shown, which is the point of the diff.
    expect(rendered).toContain('main');
  });

  it('masks operator-configured query params too', () => {
    const result = compare({
      strategy: 'json_semantic',
      rules: locationRules(),
      legacy: response({ location: 'https://app.example/cb?session_hint=legacy-hint-value' }),
      candidate: response({ location: 'https://app.example/cb?session_hint=new-hint-value' }),
      legacyRequestUrl: 'https://app.example/go',
      candidateRequestUrl: 'https://app.example/go',
      sensitiveQueryParams: ['Session_Hint'],
    });
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain('legacy-hint-value');
    expect(rendered).toContain(REDACTED);
  });

  it('honours compare: false', () => {
    expect(
      locationKinds(
        locationRules({ compare: false }),
        'https://legacy.example/a',
        'https://new.example/b',
      ),
    ).toEqual([]);
  });

  it('bounds the query mismatch list and flags truncation', () => {
    const query = (side: string) =>
      Array.from({ length: MAX_DIFFERENCES + 5 }, (_, i) => `p${i}=${side}${i}`).join('&');
    const result = compare({
      strategy: 'json_semantic',
      rules: locationRules(),
      legacy: response({ location: `https://app.example/n?${query('l')}` }),
      candidate: response({ location: `https://app.example/n?${query('n')}` }),
      legacyRequestUrl: 'https://app.example/go',
      candidateRequestUrl: 'https://app.example/go',
    });
    expect(result.mismatches).toHaveLength(MAX_DIFFERENCES);
    expect(result.diffTruncated).toBe(true);
  });
});
