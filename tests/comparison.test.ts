import { describe, expect, it } from 'vitest';
import { compare } from '../src/comparison/compare';
import { type ComparisonRules, defaultComparisonRules } from '../src/comparison/rules';
import type { HttpResponseRecord } from '../src/execution/http-client';

function resp(
  status: number,
  json: unknown,
  headers: Record<string, string> = {},
): HttpResponseRecord {
  return {
    status,
    headers,
    setCookie: [],
    bodyText: JSON.stringify(json),
    bodyJson: json,
    durationMs: 1,
  };
}

function rulesWith(patch: Partial<ComparisonRules>): ComparisonRules {
  return { ...defaultComparisonRules(), ...patch };
}

describe('compare — json_semantic / exact', () => {
  const rules = defaultComparisonRules();

  it('passes on equal bodies regardless of key order', () => {
    const result = compare({
      strategy: 'json_semantic',
      rules,
      legacy: resp(200, { a: 1, b: 2 }),
      candidate: resp(200, { b: 2, a: 1 }),
    });
    expect(result.pass).toBe(true);
    expect(result.diffText).toBeUndefined();
  });

  it('fails and addresses a changed value by path', () => {
    const result = compare({
      strategy: 'json_semantic',
      rules,
      legacy: resp(200, { device: { name: 'A' } }),
      candidate: resp(200, { device: { name: 'B' } }),
    });
    expect(result.pass).toBe(false);
    expect(result.mismatches[0].path).toBe('$.device.name');
    expect(result.mismatches[0].kind).toBe('value');
  });

  it('reports a status mismatch', () => {
    const result = compare({
      strategy: 'json_semantic',
      rules,
      legacy: resp(200, {}),
      candidate: resp(404, {}),
    });
    expect(result.mismatches.some((m) => m.kind === 'status')).toBe(true);
  });

  it('reports missing and extra fields', () => {
    const missing = compare({
      strategy: 'json_semantic',
      rules,
      legacy: resp(200, { a: 1, b: 2 }),
      candidate: resp(200, { a: 1 }),
    });
    expect(missing.mismatches.find((m) => m.path === '$.b')?.kind).toBe('missing');

    const extra = compare({
      strategy: 'json_semantic',
      rules,
      legacy: resp(200, { a: 1 }),
      candidate: resp(200, { a: 1, b: 2 }),
    });
    expect(extra.mismatches.find((m) => m.path === '$.b')?.kind).toBe('extra');
  });

  it('compares only listed headers', () => {
    const rulesWithHeader = rulesWith({ compare_headers: ['content-type'] });
    const result = compare({
      strategy: 'json_semantic',
      rules: rulesWithHeader,
      legacy: resp(200, {}, { 'content-type': 'application/json' }),
      candidate: resp(200, {}, { 'content-type': 'text/plain', date: 'differs-but-ignored' }),
    });
    expect(result.mismatches.some((m) => m.kind === 'header')).toBe(true);
  });

  it('ignores normalized paths', () => {
    const result = compare({
      strategy: 'json_semantic',
      rules: rulesWith({
        json: { ...defaultComparisonRules().json, ignore_paths: ['$.meta.ts'] },
      }),
      legacy: resp(200, { id: 1, meta: { ts: 'a' } }),
      candidate: resp(200, { id: 1, meta: { ts: 'b' } }),
    });
    expect(result.pass).toBe(true);
  });

  it('passes when arrays differ only in order, with a sort rule', () => {
    const result = compare({
      strategy: 'json_semantic',
      rules: rulesWith({
        json: { ...defaultComparisonRules().json, sort_arrays: [{ path: '$.items', key: 'id' }] },
      }),
      legacy: resp(200, { items: [{ id: 1 }, { id: 2 }] }),
      candidate: resp(200, { items: [{ id: 2 }, { id: 1 }] }),
    });
    expect(result.pass).toBe(true);
  });
});

describe('compare — redaction guarantee', () => {
  it('never leaks a redacted value into the diff', () => {
    const result = compare({
      strategy: 'json_semantic',
      rules: rulesWith({
        json: { ...defaultComparisonRules().json, redact_paths: ['$.token'] },
      }),
      legacy: resp(200, { token: 'SECRET-LEGACY', name: 'A' }),
      candidate: resp(200, { token: 'SECRET-NEW', name: 'B' }),
    });
    expect(result.pass).toBe(false); // name differs
    expect(result.diffText).toBeDefined();
    expect(result.diffText).not.toContain('SECRET-LEGACY');
    expect(result.diffText).not.toContain('SECRET-NEW');
    expect(JSON.stringify(result.mismatches)).not.toContain('SECRET');
  });

  it('masks sensitive header values in mismatches', () => {
    const result = compare({
      strategy: 'json_semantic',
      rules: rulesWith({ compare_headers: ['authorization'] }),
      legacy: resp(200, {}, { authorization: 'Bearer SECRET-LEGACY' }),
      candidate: resp(200, {}, { authorization: 'Bearer SECRET-NEW' }),
      sensitiveHeaders: ['authorization'],
    });
    expect(result.pass).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('masks a redacted path even when an expectation targets it', () => {
    const result = compare({
      strategy: 'explicit_expectations',
      rules: rulesWith({
        json: { ...defaultComparisonRules().json, redact_paths: ['$.token'] },
      }),
      candidate: resp(200, { token: 'SUPER-SECRET' }),
      expect: { body: { json_paths: { '$.token': 'anything' } } },
    });
    expect(JSON.stringify(result)).not.toContain('SUPER-SECRET');
  });
});

describe('compare — null vs absent', () => {
  const rules = defaultComparisonRules();

  it('treats a null value as present (missing/extra, not equal to absent)', () => {
    const missing = compare({
      strategy: 'json_semantic',
      rules,
      legacy: resp(200, { a: null }),
      candidate: resp(200, {}),
    });
    expect(missing.mismatches.find((m) => m.path === '$.a')?.kind).toBe('missing');

    const extra = compare({
      strategy: 'json_semantic',
      rules,
      legacy: resp(200, {}),
      candidate: resp(200, { a: null }),
    });
    expect(extra.mismatches.find((m) => m.path === '$.a')?.kind).toBe('extra');
  });
});

describe('compare — subset', () => {
  const rules = defaultComparisonRules();

  it('only compares the required paths', () => {
    const result = compare({
      strategy: 'subset',
      rules,
      legacy: resp(200, { id: 1, note: 'legacy' }),
      candidate: resp(200, { id: 1, note: 'new' }),
      requireMatchingPaths: ['$.id'],
    });
    expect(result.pass).toBe(true);
  });

  it('fails when a required path differs', () => {
    const result = compare({
      strategy: 'subset',
      rules,
      legacy: resp(200, { id: 1 }),
      candidate: resp(200, { id: 2 }),
      requireMatchingPaths: ['$.id'],
    });
    expect(result.pass).toBe(false);
    expect(result.mismatches[0].path).toBe('$.id');
  });
});

describe('compare — explicit_expectations', () => {
  const rules = defaultComparisonRules();

  it('passes when status and json paths match', () => {
    const result = compare({
      strategy: 'explicit_expectations',
      rules,
      candidate: resp(404, { error: { code: 'USER_NOT_FOUND' } }),
      expect: { status: 404, body: { json_paths: { '$.error.code': 'USER_NOT_FOUND' } } },
    });
    expect(result.pass).toBe(true);
  });

  it('fails on a wrong status or value', () => {
    const result = compare({
      strategy: 'explicit_expectations',
      rules,
      candidate: resp(200, { error: { code: 'OTHER' } }),
      expect: { status: 404, body: { json_paths: { '$.error.code': 'USER_NOT_FOUND' } } },
    });
    expect(result.pass).toBe(false);
    expect(result.mismatches.length).toBe(2);
  });
});

describe('compare — custom', () => {
  const rules = defaultComparisonRules();

  it('delegates to a named comparator returning mismatches', () => {
    const pass = compare({
      strategy: 'custom',
      rules,
      candidate: resp(200, {}),
      comparator: () => [],
    });
    expect(pass.pass).toBe(true);

    const fail = compare({
      strategy: 'custom',
      rules,
      candidate: resp(200, {}),
      comparator: () => [{ path: '$', kind: 'custom', message: 'nope' }],
    });
    expect(fail.pass).toBe(false);
    expect(fail.diffText).toContain('nope');
  });

  it('masks setCookie in a custom comparator view even when sensitiveHeaders omits set-cookie', () => {
    let observedSetCookie: unknown;
    const candidate: HttpResponseRecord = {
      ...resp(200, {}),
      setCookie: ['sid=SUPER-SECRET; Path=/; HttpOnly'],
    };
    const result = compare({
      strategy: 'custom',
      rules,
      candidate,
      comparator: (ctx) => {
        observedSetCookie = ctx.candidate.setCookie;
        return [];
      },
      // Deliberately does not include 'set-cookie' (or 'cookie') — proving the
      // comparator view masks Set-Cookie unconditionally, not just when the
      // scenario happens to configure it as sensitive.
      sensitiveHeaders: [],
    });
    expect(observedSetCookie).toEqual(['***REDACTED***']);
    expect(JSON.stringify(result)).not.toContain('SUPER-SECRET');
  });

  it('hands a custom comparator redacted responses so it cannot leak secrets', () => {
    let observedToken: unknown;
    const result = compare({
      strategy: 'custom',
      rules: rulesWith({
        json: { ...defaultComparisonRules().json, redact_paths: ['$.token'] },
      }),
      candidate: resp(200, { token: 'SUPER-SECRET' }),
      comparator: (ctx) => {
        observedToken = (ctx.candidate.bodyJson as { token: unknown }).token;
        return [{ path: '$.token', kind: 'value', actual: observedToken, message: 'token' }];
      },
    });
    expect(observedToken).toBe('***REDACTED***');
    expect(JSON.stringify(result)).not.toContain('SUPER-SECRET');
  });
});

/**
 * Which side wording a rendered diff uses is a function of where the `expected`
 * value came from, not of the mismatch kind. A two-sided comparison really does
 * have a legacy response behind `expected`; an expectation assertion has only
 * the scenario author's literal, so calling it `legacy:` would be a lie.
 */
describe('diffText vocabulary — two-sided comparisons say legacy / new', () => {
  const rules = defaultComparisonRules();

  it('renders a status mismatch with legacy / new', () => {
    const result = compare({
      strategy: 'json_semantic',
      rules,
      legacy: resp(200, {}),
      candidate: resp(404, {}),
    });
    expect(result.diffText).toBe('$.status: status differs (legacy: 200, new: 404)');
  });

  it('renders a missing key as missing in new, naming the legacy value', () => {
    const result = compare({
      strategy: 'json_semantic',
      rules,
      legacy: resp(200, { a: 1 }),
      candidate: resp(200, {}),
    });
    expect(result.diffText).toBe('$.a: missing in new (legacy: 1)');
  });

  it('renders an extra key as unexpected in new, naming the new value', () => {
    const result = compare({
      strategy: 'json_semantic',
      rules,
      legacy: resp(200, {}),
      candidate: resp(200, { b: 'two' }),
    });
    expect(result.diffText).toBe('$.b: unexpected in new (new: "two")');
  });

  it('renders nested value and array-element differences with legacy / new', () => {
    const result = compare({
      strategy: 'json_semantic',
      rules,
      legacy: resp(200, { device: { name: 'A' }, items: [1, 2] }),
      candidate: resp(200, { device: { name: 'B' }, items: [1] }),
    });
    expect(result.diffText).toBe(
      [
        '$.device.name: value differs (legacy: "A", new: "B")',
        '$.items[1]: missing in new (legacy: 2)',
      ].join('\n'),
    );
  });

  it('renders a subset-strategy path difference with legacy / new', () => {
    const result = compare({
      strategy: 'subset',
      rules,
      legacy: resp(200, { id: 1 }),
      candidate: resp(200, { id: 2 }),
      requireMatchingPaths: ['$.id'],
    });
    expect(result.diffText).toBe('$.id: value differs (legacy: 1, new: 2)');
  });

  it('renders a custom comparator with legacy / new when a legacy response exists', () => {
    const result = compare({
      strategy: 'custom',
      rules,
      legacy: resp(200, {}),
      candidate: resp(200, {}),
      comparator: () => [
        { path: '$.total', kind: 'custom', expected: 10, actual: 11, message: 'total drifted' },
      ],
    });
    expect(result.diffText).toBe('$.total: total drifted (legacy: 10, new: 11)');
  });
});

describe('diffText vocabulary — expectation-sourced results say expected / actual', () => {
  const rules = defaultComparisonRules();

  it('renders an expected status with expected / actual, never legacy', () => {
    const result = compare({
      strategy: 'explicit_expectations',
      rules,
      candidate: resp(200, {}),
      expect: { status: 404 },
    });
    expect(result.diffText).toBe(
      '$.status: status differs from expectation (expected: 404, actual: 200)',
    );
    expect(result.diffText).not.toContain('legacy');
  });

  it('renders an asserted path the response never carried as missing (expected: …)', () => {
    const result = compare({
      strategy: 'explicit_expectations',
      rules,
      candidate: resp(200, {}),
      expect: { body: { json_paths: { '$.error.code': 'USER_NOT_FOUND' } } },
    });
    expect(result.diffText).toBe('$.error.code: missing (expected: "USER_NOT_FOUND")');
    expect(result.diffText).not.toContain('legacy');
    expect(result.diffText).not.toContain(' in new');
  });

  it('renders a key the asserted literal did not name as unexpected (actual: …)', () => {
    const result = compare({
      strategy: 'explicit_expectations',
      rules,
      candidate: resp(200, { error: { code: 'A', detail: 'extra' } }),
      expect: { body: { json_paths: { '$.error': { code: 'A' } } } },
    });
    expect(result.diffText).toBe('$.error.detail: unexpected (actual: "extra")');
    expect(result.diffText).not.toContain('legacy');
    expect(result.diffText).not.toContain(' in new');
  });

  it('renders a wrong asserted value with expected / actual', () => {
    const result = compare({
      strategy: 'explicit_expectations',
      rules,
      candidate: resp(200, { error: { code: 'OTHER' } }),
      expect: { body: { json_paths: { '$.error.code': 'USER_NOT_FOUND' } } },
    });
    expect(result.diffText).toBe(
      '$.error.code: value differs (expected: "USER_NOT_FOUND", actual: "OTHER")',
    );
    expect(result.diffText).not.toContain('legacy');
  });

  it('renders a custom comparator with expected / actual when there is no legacy response', () => {
    // `new_only_assert` is the only mode that reaches `compare()` without a
    // legacy response, and `custom` is the only non-expectation strategy it
    // permits — so the absent legacy side is the signal, not the mode.
    const result = compare({
      strategy: 'custom',
      rules,
      candidate: resp(200, {}),
      comparator: () => [
        { path: '$.total', kind: 'custom', expected: 10, actual: 11, message: 'total drifted' },
      ],
    });
    expect(result.diffText).toBe('$.total: total drifted (expected: 10, actual: 11)');
    expect(result.diffText).not.toContain('legacy');
  });

  it('applies the expectation vocabulary to a comparator returning a full result too', () => {
    const result = compare({
      strategy: 'custom',
      rules,
      candidate: resp(200, {}),
      comparator: () => ({
        pass: false,
        summary: 'custom',
        mismatches: [
          { path: '$.total', kind: 'custom', expected: 10, actual: 11, message: 'total drifted' },
        ],
      }),
    });
    expect(result.diffText).toBe('$.total: total drifted (expected: 10, actual: 11)');
  });
});
