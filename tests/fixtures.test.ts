import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { RedactionTargets } from '../src/config/config';
import { ValidationError } from '../src/errors';
import {
  buildRecording,
  loadRecording,
  recordingResponse,
  writeRecording,
} from '../src/execution/fixtures';
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
  setCookie: ['session=s; Path=/; HttpOnly'],
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
    // Cookie values are secrets: not recorded unless declared safe.
    expect(recording.response.set_cookie).toBeUndefined();
    expect(JSON.stringify(recording)).not.toContain('session=s');
  });

  it('records set_cookie only when set-cookie is declared safe', () => {
    const recording = buildRecording({
      scenarioId: 's',
      stepId: 'get',
      recordedAt: '2024-01-01T00:00:00.000Z',
      request,
      response,
      safeHeaders: ['set-cookie'],
      redaction,
    });
    expect(recording.response.set_cookie).toEqual(['session=s; Path=/; HttpOnly']);
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
        setCookie: [],
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
      response: {
        status: 200,
        headers: {},
        setCookie: [],
        bodyText: '{}',
        bodyJson: {},
        durationMs: 1,
      },
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

  it('round-trips set_cookie back to the in-memory setCookie', () => {
    const recording = buildRecording({
      scenarioId: 's',
      stepId: 'get',
      recordedAt: '2024-01-01T00:00:00.000Z',
      request,
      response,
      safeHeaders: ['set-cookie'],
      redaction,
    });
    writeRecording(dir, 'cookies.json', recording);
    const replayed = recordingResponse(loadRecording(dir, 'cookies.json'));
    expect(replayed.setCookie).toEqual(['session=s; Path=/; HttpOnly']);
  });

  it('loads a pre-cookie recording, replaying it with no cookie data', () => {
    // A fixture written before set_cookie existed: no field on disk at all.
    const legacyFixture = {
      version: 1,
      scenarioId: 's',
      stepId: 'get',
      recordedAt: '2024-01-01T00:00:00.000Z',
      request: { method: 'GET', path: '/users/1' },
      response: {
        status: 200,
        headers: { etag: 'e1' },
        bodyText: '{"id":1}',
        bodyJson: { id: 1 },
        durationMs: 3,
      },
    } as const;
    writeRecording(dir, 'old.json', legacyFixture as never);
    const loaded = loadRecording(dir, 'old.json');
    expect(loaded.response.set_cookie).toBeUndefined();
    expect(recordingResponse(loaded).setCookie).toEqual([]);
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
