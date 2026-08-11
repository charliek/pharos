import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A small, self-contained mock "user-service" used by the example scenarios. Two
 * instances stand in for `legacy` and `new`, distinguished by a `variant`. Each
 * instance runs identical, deterministic logic over its own in-memory store, so
 * a `compare_live` run passes — except for the deliberately dynamic fields
 * (`metadata.requestId`, `metadata.generatedAt`, the session cookie's value) that
 * differ per request/instance and that the example contract/scenarios ignore or
 * compare presence-only. It is plain `node:http` so it runs under bun, node, and
 * Vitest alike.
 */

export type Variant = 'legacy' | 'new';

interface User {
  id: string;
  name: string;
  email: string;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
}

interface MockResponse {
  status: number;
  body: unknown;
  /** Extra response headers (e.g. `set-cookie`, `location`); merged onto content-type. */
  headers?: Record<string, string>;
}

/**
 * The `session` cookie's `SameSite` attribute, deliberately different per variant
 * — a cosmetic difference the example contract's `set_cookie.ignore_attributes`
 * exists to ignore (spec Section 8.6). The cookie *value* also differs per
 * variant (each instance mints its own session id), which is why the example
 * scenarios compare it presence-only rather than exactly.
 */
const SAME_SITE_BY_VARIANT: Record<Variant, string> = { legacy: 'Lax', new: 'Strict' };

/** A minimal `Cookie` request header parser: `name=value; name2=value2`. */
function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function seedUsers(): Map<string, User> {
  return new Map<string, User>([
    [
      'user-123',
      {
        id: 'user-123',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        status: 'ACTIVE',
        createdAt: '2024-01-01T12:00:00.000Z',
      },
    ],
    [
      'user-456',
      {
        id: 'user-456',
        name: 'Alan Turing',
        email: 'alan@example.com',
        status: 'INACTIVE',
        createdAt: '2024-01-02T08:30:00.000Z',
      },
    ],
  ]);
}

function metadata(): Record<string, string> {
  // Deliberately dynamic — the contract ignores these.
  return { requestId: randomUUID(), generatedAt: new Date().toISOString() };
}

function notFound(): MockResponse {
  return { status: 404, body: { error: { code: 'USER_NOT_FOUND', message: 'User not found' } } };
}

/** Per-instance state `handle` reads and mutates; kept out of module scope so each server is isolated. */
interface ServiceContext {
  store: Map<string, User>;
  /** Live session ids this instance has issued via `/login` (in-memory, never persisted). */
  sessions: Set<string>;
  variant: Variant;
}

function handle(
  ctx: ServiceContext,
  method: string,
  rawPath: string,
  bodyText: string,
  cookieHeader: string | undefined,
): MockResponse {
  const [path, queryString] = rawPath.split('?', 2);
  const { store, sessions, variant } = ctx;

  if (method === 'GET' && path === '/health') {
    return { status: 200, body: { status: 'ok', version: '1.0.0' } };
  }

  if (method === 'GET' && path === '/users') {
    // Return items in an incidental order so the contract's sort_arrays rule is
    // load-bearing: legacy and new may order differently, yet compare equal.
    const items = [...store.values()];
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return { status: 200, body: { items, metadata: metadata() } };
  }

  if (method === 'POST' && path === '/login') {
    // Accepts any JSON credentials fixture — this mock never rejects a login,
    // it only demonstrates the session-cookie shape the example scenarios
    // exercise. Each instance mints its own session id, so the cookie *value*
    // is deliberately not shared between legacy and new.
    const sessionId = randomUUID();
    sessions.add(sessionId);
    const cookie = `session=${sessionId}; Path=/; HttpOnly; SameSite=${SAME_SITE_BY_VARIANT[variant]}`;
    return { status: 200, body: { ok: true }, headers: { 'set-cookie': cookie } };
  }

  if (method === 'GET' && path === '/profile') {
    const sessionId = parseCookieHeader(cookieHeader).get('session');
    if (sessionId && sessions.has(sessionId)) {
      return { status: 200, body: { authenticated: true } };
    }
    return {
      status: 401,
      body: { error: { code: 'UNAUTHENTICATED', message: 'no valid session' } },
    };
  }

  if (method === 'GET' && path === '/users/find') {
    // A redirect endpoint returning a *relative* Location — legacy and new run
    // on different origins (different ports here), so a relative value is what
    // keeps the example's `location` contract dimension meaningful with
    // `origin: ignore` (spec Section 8.6).
    const name = new URLSearchParams(queryString ?? '').get('name');
    const match = [...store.values()].find((user) => user.name === name);
    if (!match) return notFound();
    return {
      status: 303,
      body: { redirecting_to: `/users/${match.id}` },
      headers: { location: `/users/${match.id}` },
    };
  }

  const userMatch = /^\/users\/([^/]+)$/.exec(path);
  if (userMatch) {
    const id = decodeURIComponent(userMatch[1]);
    if (method === 'GET') {
      const user = store.get(id);
      return user ? { status: 200, body: { ...user, metadata: metadata() } } : notFound();
    }
    if (method === 'DELETE') {
      if (!store.has(id)) return notFound();
      store.delete(id);
      return { status: 200, body: { deleted: id } };
    }
  }

  if (method === 'POST' && path === '/users') {
    let payload: { email?: string; name?: string };
    try {
      payload = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      payload = {};
    }
    if (!payload.email) {
      return {
        status: 422,
        body: { error: { code: 'VALIDATION_ERROR', message: 'email is required' } },
      };
    }
    // Deterministic id + timestamp so both instances agree on the created resource.
    const id = `created-${payload.email.split('@')[0]}`;
    const user: User = {
      id,
      name: payload.name ?? 'New User',
      email: payload.email,
      status: 'ACTIVE',
      createdAt: '2024-06-01T00:00:00.000Z',
    };
    store.set(id, user);
    return { status: 201, body: { ...user, metadata: metadata() } };
  }

  return {
    status: 404,
    body: { error: { code: 'NOT_FOUND', message: `no route for ${method} ${path}` } },
  };
}

export interface MockServer {
  url: string;
  close: () => Promise<void>;
}

/** Create an HTTP server over a fresh store, buffering the body and dispatching to `handle`. */
function createUserServiceServer(variant: Variant): Server {
  const ctx: ServiceContext = { store: seedUsers(), sessions: new Set<string>(), variant };
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const result = handle(
        ctx,
        req.method ?? 'GET',
        req.url ?? '/',
        Buffer.concat(chunks).toString('utf8'),
        req.headers.cookie,
      );
      res.statusCode = result.status;
      res.setHeader('content-type', 'application/json');
      for (const [name, value] of Object.entries(result.headers ?? {})) {
        res.setHeader(name, value);
      }
      res.end(JSON.stringify(result.body));
    });
  });
}

/** Start a fresh mock user-service on an ephemeral port. */
export async function startUserApiServer(variant: Variant): Promise<MockServer> {
  const server = createUserServiceServer(variant);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/** Start the mock on a fixed port for local/standalone use (PORT env, default 3001). */
export function listenOnPort(port: number, variant: Variant): Server {
  const server = createUserServiceServer(variant);
  server.listen(port, () => {
    process.stdout.write(`mock user-service (${variant}) listening on http://127.0.0.1:${port}\n`);
  });
  return server;
}

if ((import.meta as { main?: boolean }).main) {
  const port = Number(process.env.PORT ?? 3001);
  const variant: Variant = process.env.VARIANT === 'new' ? 'new' : 'legacy';
  listenOnPort(port, variant);
}
