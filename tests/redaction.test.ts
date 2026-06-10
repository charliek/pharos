import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  redactHeaderMismatches,
  redactHeaders,
  redactJsonValue,
  redactUrl,
} from '../src/comparison/redaction';

describe('redactHeaders', () => {
  it('masks configured headers case-insensitively, preserving others', () => {
    const out = redactHeaders({ Authorization: 'Bearer abc', 'content-type': 'application/json' }, [
      'authorization',
    ]);
    expect(out.Authorization).toBe(REDACTED);
    expect(out['content-type']).toBe('application/json');
  });
});

describe('redactUrl', () => {
  it('masks configured query parameters', () => {
    const out = redactUrl('https://h/p?access_token=secret&page=2', ['access_token']);
    expect(out).toContain('access_token=');
    expect(out).not.toContain('secret');
    expect(out).toContain('page=2');
  });

  it('masks query params in a relative request path', () => {
    const out = redactUrl('/users?access_token=secret&page=2', ['access_token']);
    expect(out.startsWith('/users')).toBe(true);
    expect(out).not.toContain('secret');
    expect(out).toContain('page=2');
  });

  it('returns the url unchanged when no params match', () => {
    expect(redactUrl('https://h/p?page=2', ['access_token'])).toBe('https://h/p?page=2');
  });
});

describe('redactHeaderMismatches', () => {
  it('masks sensitive header values and leaves others intact', () => {
    const out = redactHeaderMismatches(
      [
        { path: 'headers.authorization', kind: 'header', expected: 'a', actual: 'b', message: 'x' },
        {
          path: 'headers.content-type',
          kind: 'header',
          expected: 'json',
          actual: 'text',
          message: 'y',
        },
      ],
      ['authorization'],
    );
    expect(out[0].expected).toBe(REDACTED);
    expect(out[0].actual).toBe(REDACTED);
    expect(out[1].expected).toBe('json');
  });
});

describe('redactJsonValue', () => {
  it('masks configured json paths in a deep clone', () => {
    const input = { user: { email: 'a@b.com' }, id: 1 };
    const out = redactJsonValue(input, ['$.user.email']) as typeof input;
    expect(out.user.email).toBe(REDACTED);
    expect(out.id).toBe(1);
    expect(input.user.email).toBe('a@b.com'); // original untouched
  });
});
