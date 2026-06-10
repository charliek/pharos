import { afterEach, describe, expect, it } from 'vitest';
import { buildUrl, sendRequest } from '../src/execution/http-client';
import { replyJson, startTestServer, type TestServer } from './helpers/server';

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('buildUrl', () => {
  it('joins base and path without dropping a base path prefix', () => {
    expect(buildUrl('http://h/api', '/users')).toBe('http://h/api/users');
    expect(buildUrl('http://h/', 'users')).toBe('http://h/users');
  });

  it('appends query parameters and omits nulls', () => {
    const url = buildUrl('http://h', '/users', { page: 2, active: true, skip: null });
    expect(url).toContain('page=2');
    expect(url).toContain('active=true');
    expect(url).not.toContain('skip');
  });
});

describe('sendRequest', () => {
  it('sends method, path, and query; captures status and JSON', async () => {
    server = await startTestServer((_req, res) => replyJson(res, 200, { ok: true }));
    const record = await sendRequest(
      { baseUrl: server.url },
      { method: 'GET', path: '/users/1', query: { detail: true } },
    );
    expect(record.status).toBe(200);
    expect(record.bodyJson).toEqual({ ok: true });
    expect(server.requests[0].method).toBe('GET');
    expect(server.requests[0].url).toBe('/users/1?detail=true');
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('sends a JSON body with an inferred content-type', async () => {
    server = await startTestServer((_req, res) => replyJson(res, 201, {}));
    await sendRequest(
      { baseUrl: server.url },
      { method: 'POST', path: '/users', body: { name: 'Ada' } },
    );
    const captured = server.requests[0];
    expect(captured.headers['content-type']).toContain('application/json');
    expect(JSON.parse(captured.body)).toEqual({ name: 'Ada' });
  });

  it('sends a string body verbatim without forcing content-type', async () => {
    server = await startTestServer((_req, res) => replyJson(res, 200, {}));
    await sendRequest(
      { baseUrl: server.url },
      {
        method: 'POST',
        path: '/raw',
        body: 'plain-text',
        headers: { 'content-type': 'text/plain' },
      },
    );
    const captured = server.requests[0];
    expect(captured.body).toBe('plain-text');
    expect(captured.headers['content-type']).toBe('text/plain');
  });

  it('applies default headers and lets per-request headers override', async () => {
    server = await startTestServer((_req, res) => replyJson(res, 200, {}));
    await sendRequest(
      { baseUrl: server.url, defaultHeaders: { 'x-default': 'd', 'x-both': 'base' } },
      { method: 'GET', path: '/', headers: { 'x-both': 'override' } },
    );
    const captured = server.requests[0];
    expect(captured.headers['x-default']).toBe('d');
    expect(captured.headers['x-both']).toBe('override');
  });

  it('preserves a non-JSON body as text with no bodyJson', async () => {
    server = await startTestServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain');
      res.end('not json');
    });
    const record = await sendRequest({ baseUrl: server.url }, { method: 'GET', path: '/' });
    expect(record.bodyText).toBe('not json');
    expect(record.bodyJson).toBeUndefined();
  });

  it('captures a timeout as an error without throwing', async () => {
    server = await startTestServer((_req, res) => {
      const timer = setTimeout(() => {
        if (!res.destroyed) res.end('late');
      }, 300);
      res.on('close', () => clearTimeout(timer));
    });
    const record = await sendRequest(
      { baseUrl: server.url },
      { method: 'GET', path: '/slow', timeoutMs: 40 },
    );
    expect(record.status).toBe(0);
    expect(record.error?.type).toBe('timeout');
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures a connection error without throwing', async () => {
    // Nothing listening on this port.
    const record = await sendRequest(
      { baseUrl: 'http://127.0.0.1:1' },
      { method: 'GET', path: '/' },
    );
    expect(record.status).toBe(0);
    expect(record.error?.type).toBe('network');
  });

  it('returns an error record for an invalid base URL (never throws)', async () => {
    const record = await sendRequest({ baseUrl: 'not-a-url' }, { method: 'GET', path: '/x' });
    expect(record.status).toBe(0);
    expect(record.error?.type).toBe('network');
  });

  it('returns an error record for an unserializable body (never throws)', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const record = await sendRequest(
      { baseUrl: 'http://127.0.0.1:1' },
      { method: 'POST', path: '/x', body: circular },
    );
    expect(record.status).toBe(0);
    expect(record.error).toBeDefined();
  });
});
