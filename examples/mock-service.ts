import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A small, self-contained mock "user-service" used by the example scenarios. Two
 * instances stand in for `legacy` and `new`. Each instance runs identical,
 * deterministic logic over its own in-memory store, so a `compare_live` run
 * passes — except for the deliberately dynamic fields (`metadata.requestId`,
 * `metadata.generatedAt`) that differ per request and that the example contract
 * ignores. It is plain `node:http` so it runs under bun, node, and Vitest alike.
 */

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

function handle(
  store: Map<string, User>,
  method: string,
  rawPath: string,
  bodyText: string,
): MockResponse {
  const path = rawPath.split('?')[0];

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
function createUserServiceServer(): Server {
  const store = seedUsers();
  return createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const result = handle(
        store,
        req.method ?? 'GET',
        req.url ?? '/',
        Buffer.concat(chunks).toString('utf8'),
      );
      res.statusCode = result.status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(result.body));
    });
  });
}

/** Start a fresh mock user-service on an ephemeral port. */
export async function startUserApiServer(): Promise<MockServer> {
  const server = createUserServiceServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/** Start the mock on a fixed port for local/standalone use (PORT env, default 3001). */
export function listenOnPort(port: number): Server {
  const server = createUserServiceServer();
  server.listen(port, () => {
    process.stdout.write(`mock user-service listening on http://127.0.0.1:${port}\n`);
  });
  return server;
}

if ((import.meta as { main?: boolean }).main) {
  const port = Number(process.env.PORT ?? 3001);
  listenOnPort(port);
}
