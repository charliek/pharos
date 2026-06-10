import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RedactionTargets } from '../src/config/config';
import { ValidationError } from '../src/errors';
import { buildRecording, loadRecording, writeRecording } from '../src/execution/fixtures';
import type { HttpRequestSpec, HttpResponseRecord } from '../src/execution/http-client';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pharos-fixtures-'));
});

const redaction: RedactionTargets = {
  headers: [],
  json_paths: ['$.token'],
  query_params: ['access_token'],
};

const request: HttpRequestSpec = {
  method: 'GET',
  path: '/users/1?access_token=secret',
  headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
};
const response: HttpResponseRecord = {
  status: 200,
  headers: { 'content-type': 'application/json', 'set-cookie': 'session=s', etag: 'e1' },
  bodyText: '{"id":1,"token":"SECRET"}',
  bodyJson: { id: 1, token: 'SECRET' },
  durationMs: 5,
};

describe('buildRecording', () => {
  it('keeps only safe headers and redacts secrets', () => {
    const recording = buildRecording({
      scenarioId: 's',
      stepId: 'get',
      recordedAt: '2024-01-01T00:00:00.000Z',
      request,
      response,
      safeHeaders: ['content-type', 'etag'],
      redaction,
    });
    // Only safe headers survive.
    expect(recording.response.headers).toEqual({ 'content-type': 'application/json', etag: 'e1' });
    expect(recording.request.headers).toEqual({ 'content-type': 'application/json' });
    // Body secret masked, and bodyText regenerated to match.
    expect(JSON.stringify(recording)).not.toContain('SECRET');
    expect(recording.response.bodyText).toBe(JSON.stringify({ id: 1, token: '***REDACTED***' }));
    // Query param masked.
    expect(recording.request.path).not.toContain('secret');
  });

  it('does not persist a non-JSON response body (unredactable)', () => {
    const recording = buildRecording({
      scenarioId: 's',
      stepId: 'get',
      recordedAt: '2024-01-01T00:00:00.000Z',
      request: { method: 'GET', path: '/x' },
      response: {
        status: 200,
        headers: {},
        bodyText: 'token=SECRET-PLAINTEXT',
        bodyJson: undefined,
        durationMs: 1,
      },
      safeHeaders: [],
      redaction,
    });
    expect(JSON.stringify(recording)).not.toContain('SECRET-PLAINTEXT');
    expect(recording.response.bodyJson).toBeUndefined();
  });

  it('rejects a fixture path that escapes the fixture directory', () => {
    const recording = buildRecording({
      scenarioId: 's',
      stepId: 'get',
      recordedAt: '2024-01-01T00:00:00.000Z',
      request: { method: 'GET', path: '/x' },
      response: { status: 200, headers: {}, bodyText: '{}', bodyJson: {}, durationMs: 1 },
      safeHeaders: [],
      redaction,
    });
    expect(() => writeRecording(dir, '../escape.json', recording)).toThrow(ValidationError);
  });
});

describe('writeRecording / loadRecording', () => {
  it('round-trips a recording', () => {
    const recording = buildRecording({
      scenarioId: 's',
      stepId: 'get',
      recordedAt: '2024-01-01T00:00:00.000Z',
      request,
      response,
      safeHeaders: ['content-type'],
      redaction,
    });
    writeRecording(dir, 'a/b.json', recording);
    expect(loadRecording(dir, 'a/b.json')).toEqual(recording);
  });

  it('fails clearly on a missing fixture', () => {
    try {
      loadRecording(dir, 'missing.json');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues[0].message).toMatch(/not found/);
    }
  });

  it('rejects an invalid recording', () => {
    writeRecording(dir, 'bad.json', { version: 2 } as never);
    expect(() => loadRecording(dir, 'bad.json')).toThrow(ValidationError);
  });
});
