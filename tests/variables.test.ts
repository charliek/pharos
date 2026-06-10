import { describe, expect, it } from 'vitest';
import type { HttpResponseRecord } from '../src/execution/http-client';
import {
  extractValue,
  substituteText,
  substituteValue,
  type VariableContext,
  VariableError,
} from '../src/execution/variables';

const ctx: VariableContext = {
  variables: { userId: 'u1', payload: { a: 1, b: [2, 3] } },
  env: { AUTH_TOKEN: 'tok' } as NodeJS.ProcessEnv,
};

describe('substitution', () => {
  it('substitutes an embedded variable into a string', () => {
    expect(substituteText('/users/{{ variables.userId }}', ctx)).toBe('/users/u1');
  });

  it('returns the raw value for a whole-string template', () => {
    expect(substituteValue('{{ variables.payload }}', ctx)).toEqual({ a: 1, b: [2, 3] });
  });

  it('resolves env variables', () => {
    expect(substituteText('Bearer {{ env.AUTH_TOKEN }}', ctx)).toBe('Bearer tok');
  });

  it('resolves built-ins', () => {
    expect(substituteText('{{ random.uuid }}', ctx)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(typeof substituteValue('{{ now.epochMs }}', ctx)).toBe('number');
  });

  it('substitutes recursively into objects', () => {
    expect(
      substituteValue({ url: '/u/{{ variables.userId }}', auth: '{{ env.AUTH_TOKEN }}' }, ctx),
    ).toEqual({ url: '/u/u1', auth: 'tok' });
  });

  it('fails with a clear message for a missing variable', () => {
    expect(() => substituteText('{{ variables.missing }}', ctx)).toThrow(VariableError);
    expect(() => substituteText('{{ variables.missing }}', ctx)).toThrow(/missing/);
  });

  it('fails with a clear message for a missing env var', () => {
    expect(() => substituteText('{{ env.NOPE }}', ctx)).toThrow(/NOPE/);
  });
});

describe('extraction', () => {
  const candidate: HttpResponseRecord = {
    status: 200,
    headers: { etag: 'e1' },
    bodyText: '{"id":"x1"}',
    bodyJson: { id: 'x1' },
    durationMs: 1,
  };

  it('extracts a body value by JSONPath', () => {
    expect(extractValue({ from: 'new.body', path: '$.id' }, { candidate })).toBe('x1');
  });

  it('extracts a header by name (case-insensitive)', () => {
    expect(extractValue({ from: 'new.headers', path: 'ETag' }, { candidate })).toBe('e1');
  });

  it('fails when the requested side is unavailable', () => {
    expect(() => extractValue({ from: 'legacy.body', path: '$.id' }, { candidate })).toThrow(
      VariableError,
    );
  });

  it("rejects 'response.*' when both responses exist (ambiguous)", () => {
    expect(() =>
      extractValue({ from: 'response.body', path: '$.id' }, { legacy: candidate, candidate }),
    ).toThrow(/ambiguous/);
  });

  it("allows 'response.*' with a single response", () => {
    expect(extractValue({ from: 'response.body', path: '$.id' }, { candidate })).toBe('x1');
  });
});
