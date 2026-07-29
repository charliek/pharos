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

  it('uses an absolute same-origin path as-is, keeping its query', () => {
    expect(buildUrl('http://h/api', 'http://h/oauth2/auth?state=abc')).toBe(
      'http://h/oauth2/auth?state=abc',
    );
  });

  it('refuses a cross-origin absolute path, naming both origins', () => {
    expect(() => buildUrl('http://h/api', 'https://elsewhere.test/callback')).toThrow(
      /https:\/\/elsewhere\.test.*http:\/\/h/,
    );
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

  it('captures every Set-Cookie header losslessly', async () => {
    server = await startTestServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('set-cookie', [
        'sid=abc; Path=/; HttpOnly',
        'refresh=r1; Path=/api/v1/auth; Secure',
        'sid=def; Path=/other',
      ]);
      res.end('{}');
    });
    const record = await sendRequest({ baseUrl: server.url }, { method: 'GET', path: '/login' });
    expect(record.setCookie).toEqual([
      'sid=abc; Path=/; HttpOnly',
      'refresh=r1; Path=/api/v1/auth; Secure',
      'sid=def; Path=/other',
    ]);
    // The single-value map stays lossy — that is why setCookie exists.
    expect(record.headers['set-cookie']).not.toContain('refresh=r1');
  });

  it('captures an empty setCookie array when no cookies are set', async () => {
    server = await startTestServer((_req, res) => replyJson(res, 200, {}));
    const record = await sendRequest({ baseUrl: server.url }, { method: 'GET', path: '/' });
    expect(record.setCookie).toEqual([]);
  });

  /** Answers `/start` with a 302 to `/end`, setting a cookie on the hop. */
  const redirectingServer = () =>
    startTestServer((req, res) => {
      if (req.url === '/start') {
        res.statusCode = 302;
        res.setHeader('location', '/end');
        res.setHeader('set-cookie', 'hop=1; Path=/');
        res.end();
        return;
      }
      replyJson(res, 200, { arrived: true });
    });

  it('follows redirects by default', async () => {
    server = await redirectingServer();
    const record = await sendRequest({ baseUrl: server.url }, { method: 'GET', path: '/start' });
    expect(record.status).toBe(200);
    expect(record.bodyJson).toEqual({ arrived: true });
  });

  it('returns the 30x itself when follow_redirects is false', async () => {
    server = await redirectingServer();
    const record = await sendRequest(
      { baseUrl: server.url },
      { method: 'GET', path: '/start', followRedirects: false },
    );
    expect(record.status).toBe(302);
    expect(record.headers.location).toBe('/end');
    expect(record.setCookie).toEqual(['hop=1; Path=/']);
    expect(server.requests).toHaveLength(1);
  });

  it('sends a form body urlencoded with an inferred content-type', async () => {
    server = await startTestServer((_req, res) => replyJson(res, 200, {}));
    await sendRequest(
      { baseUrl: server.url },
      {
        method: 'POST',
        path: '/oauth2/token',
        form: { grant_type: 'authorization_code', code: 'a b&c', expires_in: 300, offline: true },
      },
    );
    const captured = server.requests[0];
    expect(captured.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(captured.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'a b&c',
      expires_in: '300',
      offline: 'true',
    });
  });

  it('lets a per-request content-type override the form default', async () => {
    server = await startTestServer((_req, res) => replyJson(res, 200, {}));
    await sendRequest(
      { baseUrl: server.url },
      {
        method: 'POST',
        path: '/t',
        form: { a: '1' },
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      },
    );
    expect(server.requests[0].headers['content-type']).toBe(
      'application/x-www-form-urlencoded; charset=utf-8',
    );
  });

  it('sends an OPTIONS preflight and captures the CORS response', async () => {
    server = await startTestServer((_req, res) => {
      res.statusCode = 204;
      res.setHeader('access-control-allow-origin', 'https://app.test');
      res.end();
    });
    const record = await sendRequest(
      { baseUrl: server.url },
      {
        method: 'OPTIONS',
        path: '/api/v1/session',
        headers: { origin: 'https://app.test', 'access-control-request-method': 'GET' },
      },
    );
    expect(record.status).toBe(204);
    expect(record.headers['access-control-allow-origin']).toBe('https://app.test');
    expect(server.requests[0].method).toBe('OPTIONS');
  });

  it('sends a HEAD request without a body', async () => {
    server = await startTestServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-length', '17');
      res.end();
    });
    const record = await sendRequest({ baseUrl: server.url }, { method: 'HEAD', path: '/users' });
    expect(record.status).toBe(200);
    expect(record.bodyText).toBe('');
    expect(server.requests[0].method).toBe('HEAD');
  });

  it('refuses a body on a bodyless method as a request error (never throws)', async () => {
    const record = await sendRequest(
      { baseUrl: 'http://127.0.0.1:1' },
      { method: 'HEAD', path: '/x', body: { a: 1 } },
    );
    expect(record.status).toBe(0);
    expect(record.error?.type).toBe('request');
    expect(record.error?.message).toContain('HEAD');
  });

  it('refuses a form body on GET as a request error (never throws)', async () => {
    const record = await sendRequest(
      { baseUrl: 'http://127.0.0.1:1' },
      { method: 'GET', path: '/x', form: { a: '1' } },
    );
    expect(record.status).toBe(0);
    expect(record.error?.type).toBe('request');
    expect(record.error?.message).toContain('GET');
    expect(record.error?.message).toMatch(/form/);
  });

  it('refuses body and form together as a request error (never throws)', async () => {
    const record = await sendRequest(
      { baseUrl: 'http://127.0.0.1:1' },
      { method: 'POST', path: '/x', body: { a: 1 }, form: { a: '1' } },
    );
    expect(record.error?.type).toBe('request');
    expect(record.error?.message).toMatch(/mutually exclusive/);
  });

  it('sends an absolute same-origin path (Location replay)', async () => {
    server = await startTestServer((_req, res) => replyJson(res, 200, { ok: true }));
    const record = await sendRequest(
      { baseUrl: server.url },
      { method: 'GET', path: `${server.url}/oauth2/auth?client_id=app` },
    );
    expect(record.status).toBe(200);
    expect(server.requests[0].url).toBe('/oauth2/auth?client_id=app');
  });

  it('returns a request error for a cross-origin absolute path (never throws)', async () => {
    server = await startTestServer((_req, res) => replyJson(res, 200, {}));
    const record = await sendRequest(
      { baseUrl: server.url },
      { method: 'GET', path: 'https://elsewhere.test/callback' },
    );
    expect(record.status).toBe(0);
    expect(record.error?.type).toBe('request');
    expect(record.error?.message).toContain('https://elsewhere.test');
    expect(record.error?.message).toContain(server.url);
    expect(server.requests).toHaveLength(0);
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
