import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A request captured by the test server, for assertions. */
export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface TestServer {
  url: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

export type TestHandler = (request: CapturedRequest, response: ServerResponse) => void;

/**
 * Start a localhost HTTP server for client tests. Each request is buffered and
 * recorded in `requests`, then passed to `handler` to produce a response. Uses
 * node:http so it runs identically under node and bun.
 */
export async function startTestServer(handler: TestHandler): Promise<TestServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk as Buffer));
    req.on('end', () => {
      const captured: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers as Record<string, string | undefined>,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(captured);
      handler(captured, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Reply with a JSON body and status. */
export function replyJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}
