import { describe, expect, it } from 'vitest';
import {
  getAtPath,
  parseJsonPath,
  removeAtPath,
  transformAtPath,
} from '../src/comparison/jsonpath';
import {
  deepEqual,
  normalizeJson,
  normalizeTimestamp,
  sortArrayAsSet,
  sortArrayByKey,
  stableStringify,
} from '../src/comparison/normalize';
import { emptyJsonNormalization, type JsonNormalization } from '../src/comparison/rules';

function rules(overrides: Partial<JsonNormalization>): JsonNormalization {
  return { ...emptyJsonNormalization(), ...overrides };
}

describe('stableStringify / deepEqual', () => {
  it('is independent of object key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(deepEqual({ a: 1, b: { c: 3 } }, { b: { c: 3 }, a: 1 })).toBe(true);
  });

  it('distinguishes different values', () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});

describe('jsonpath evaluation', () => {
  it('gets a nested value and wildcard values', () => {
    expect(getAtPath({ a: { b: 5 } }, parseJsonPath('$.a.b'))).toEqual([5]);
    expect(getAtPath({ items: [{ id: 1 }, { id: 2 }] }, parseJsonPath('$.items[*].id'))).toEqual([
      1, 2,
    ]);
  });

  it('removes a field, including under a wildcard', () => {
    const value = {
      items: [
        { id: 1, t: 'x' },
        { id: 2, t: 'y' },
      ],
    };
    removeAtPath(value, parseJsonPath('$.items[*].t'));
    expect(value).toEqual({ items: [{ id: 1 }, { id: 2 }] });
  });

  it('transforms matched values in place', () => {
    const value = { a: { n: 2 } };
    transformAtPath(value, parseJsonPath('$.a.n'), (n) => (n as number) * 10);
    expect(value).toEqual({ a: { n: 20 } });
  });
});

describe('normalization transforms', () => {
  it('removes ignored paths (nested and wildcard)', () => {
    const out = normalizeJson(
      { id: 1, meta: { requestId: 'r' }, items: [{ id: 1, ts: 't' }] },
      rules({ ignore_paths: ['$.meta.requestId', '$.items[*].ts'] }),
    );
    expect(out).toEqual({ id: 1, meta: {}, items: [{ id: 1 }] });
  });

  it('masks redacted paths', () => {
    const out = normalizeJson({ token: 'secret' }, rules({ redact_paths: ['$.token'] }));
    expect(out).toEqual({ token: '***REDACTED***' });
  });

  it('sorts arrays by key deterministically', () => {
    const a = normalizeJson(
      { items: [{ id: 'b' }, { id: 'a' }] },
      rules({ sort_arrays: [{ path: '$.items', key: 'id' }] }),
    );
    const b = normalizeJson(
      { items: [{ id: 'a' }, { id: 'b' }] },
      rules({ sort_arrays: [{ path: '$.items', key: 'id' }] }),
    );
    expect(deepEqual(a, b)).toBe(true);
  });

  it('orders unordered arrays as sets', () => {
    const a = normalizeJson(
      { tags: ['x', 'y'] },
      rules({ unordered_arrays: [{ path: '$.tags' }] }),
    );
    const b = normalizeJson(
      { tags: ['y', 'x'] },
      rules({ unordered_arrays: [{ path: '$.tags' }] }),
    );
    expect(deepEqual(a, b)).toBe(true);
  });

  it('maps enum aliases to a canonical token', () => {
    const out = normalizeJson(
      { status: 'ACTIVE' },
      rules({ enum_aliases: [{ path: '$.status', aliases: { ACTIVE: 'enabled' } }] }),
    );
    expect(out).toEqual({ status: 'enabled' });
  });

  it('does not mutate its input', () => {
    const input = { token: 'secret' };
    normalizeJson(input, rules({ redact_paths: ['$.token'] }));
    expect(input).toEqual({ token: 'secret' });
  });
});

describe('normalizeTimestamp', () => {
  it('treats the same instant across zones as equal at seconds precision', () => {
    const a = normalizeTimestamp('2024-01-01T12:30:45+05:30', 'seconds');
    const b = normalizeTimestamp('2024-01-01T07:00:45Z', 'seconds');
    expect(a).toBe(b);
  });

  it('keeps genuinely different instants different', () => {
    const a = normalizeTimestamp('2024-01-01T12:30:45Z', 'seconds');
    const b = normalizeTimestamp('2024-01-01T12:30:46Z', 'seconds');
    expect(a).not.toBe(b);
  });

  it('truncates to the configured precision', () => {
    const a = normalizeTimestamp('2024-01-01T12:30:45.123Z', 'minutes');
    const b = normalizeTimestamp('2024-01-01T12:30:05.999Z', 'minutes');
    expect(a).toBe(b);
  });

  it('leaves unparseable values untouched', () => {
    expect(normalizeTimestamp('not-a-date', 'seconds')).toBe('not-a-date');
  });

  it('treats a numeric value as an epoch in milliseconds', () => {
    const a = normalizeTimestamp(1_704_110_400_123, 'seconds');
    const b = normalizeTimestamp(1_704_110_400_999, 'seconds');
    expect(a).toBe(b);
    expect(a).toBe('2024-01-01T12:00:00.000Z');
  });
});

describe('array sort helpers', () => {
  it('sortArrayByKey leaves non-arrays untouched', () => {
    expect(sortArrayByKey('x', 'id')).toBe('x');
  });
  it('sortArrayAsSet leaves non-arrays untouched', () => {
    expect(sortArrayAsSet(42)).toBe(42);
  });
});
