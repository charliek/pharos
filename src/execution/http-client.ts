import { performance } from 'node:perf_hooks';

/**
 * The black-box HTTP client (spec Section 9). Builds absolute URLs from a base
 * URL + request spec, sends the request with `fetch`, and captures status,
 * headers, body text, parsed JSON (when possible), duration, and errors. It does
 * not log — redaction happens in the reporting layer.
 */

/** Request methods Pharos issues (spec Section 9; narrower than contract match methods). */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A fully-resolved request. Template variables (spec Section 7.1) are already
 * substituted into `path`, `query`, `headers`, and `body` by the runner before
 * a spec reaches the client — the client does no substitution of its own.
 */
export interface HttpRequestSpec {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | null>;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResponseRecord {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  bodyJson?: unknown;
  durationMs: number;
  error?: { type: string; message: string };
}

export interface HttpClientOptions {
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Join a base URL and request path, then append query parameters. A leading
 * slash on the path is preserved without dropping a base path prefix (unlike
 * `new URL(path, base)`). Null query values are omitted.
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | null>,
): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(base + suffix);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null) continue;
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

function buildHeaders(
  defaults: Record<string, string> | undefined,
  perRequest: Record<string, string> | undefined,
): Headers {
  const headers = new Headers(defaults);
  if (perRequest) {
    for (const [key, value] of Object.entries(perRequest)) {
      headers.set(key, value); // case-insensitive; per-request wins
    }
  }
  return headers;
}

/** Serialize the request body, defaulting the content-type to JSON for objects. */
function applyBody(init: RequestInit, headers: Headers, spec: HttpRequestSpec): void {
  if (spec.body === undefined || spec.method === 'GET') return;
  if (typeof spec.body === 'string') {
    init.body = spec.body;
    return;
  }
  init.body = JSON.stringify(spec.body);
  if (!headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function tryParseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Issue a single request, capturing the outcome. Never throws — every failure
 * (an invalid URL or body built before the call, a timeout, a connection error)
 * is returned as `error` on the record with status 0. All request setup runs
 * inside the try so the never-throw contract holds even for malformed input.
 */
export async function sendRequest(
  options: HttpClientOptions,
  spec: HttpRequestSpec,
): Promise<HttpResponseRecord> {
  const timeoutMs = spec.timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  let url = '';
  try {
    url = buildUrl(options.baseUrl, spec.path, spec.query);
    const headers = buildHeaders(options.defaultHeaders, spec.headers);
    const init: RequestInit = { method: spec.method, headers, signal: controller.signal };
    applyBody(init, headers, spec);

    const response = await fetch(url, init);
    const bodyText = await response.text();
    const durationMs = performance.now() - start;
    return {
      status: response.status,
      headers: headersToObject(response.headers),
      bodyText,
      bodyJson: tryParseJson(bodyText),
      durationMs,
    };
  } catch (error) {
    const durationMs = performance.now() - start;
    const aborted = error instanceof Error && error.name === 'AbortError';
    const target = url || `${options.baseUrl}${spec.path}`;
    return {
      status: 0,
      headers: {},
      bodyText: '',
      durationMs,
      error: {
        type: aborted ? 'timeout' : 'network',
        message: aborted
          ? `request to ${target} timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error),
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
