import { performance } from 'node:perf_hooks';

/**
 * The black-box HTTP client (spec Section 9). Builds absolute URLs from a base
 * URL + request spec, sends the request with `fetch`, and captures status,
 * headers, every `Set-Cookie` value, body text, parsed JSON (when possible),
 * duration, and errors. It does not log — redaction happens in the reporting
 * layer. It is stateless per request; the cookie jar lives in the runner.
 */

/**
 * Request methods Pharos issues (spec Section 9.1). Single-sourced here — the
 * scenario schema and the recording schema both validate against this list, so
 * the three can never drift.
 */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Methods that must not carry a body — an HTTP/`fetch` quirk, not a Pharos rule (Section 9.1). */
export const BODYLESS_METHODS: ReadonlySet<HttpMethod> = new Set<HttpMethod>(['OPTIONS', 'HEAD']);

/**
 * A fully-resolved request. Template variables (spec Section 7.1) are already
 * substituted into `path`, `query`, `headers`, `body`, and `form` by the runner
 * before a spec reaches the client — the client does no substitution of its own.
 */
export interface HttpRequestSpec {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | null>;
  headers?: Record<string, string>;
  body?: unknown;
  /** Urlencoded body; mutually exclusive with `body` (spec Section 9.6). */
  form?: Record<string, string | number | boolean>;
  /** Default true; `false` returns the 30x itself instead of following it (spec Section 9.3). */
  followRedirects?: boolean;
  timeoutMs?: number;
}

export interface HttpResponseRecord {
  status: number;
  headers: Record<string, string>;
  /** Every `Set-Cookie` header, losslessly; empty when none (spec Section 9.2). */
  setCookie: string[];
  bodyText: string;
  bodyJson?: unknown;
  durationMs: number;
  error?: { type: string; message: string };
}

/**
 * A request that cannot be shaped as specified (a cross-origin absolute path, a
 * body on a bodyless method, `body` and `form` together). Distinct from a
 * network failure: nothing was sent, and the fault is in the scenario. Surfaced
 * to the caller as `error.type: 'request'` — `sendRequest` still never throws.
 */
export class RequestShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RequestShapeError';
  }
}

export interface HttpClientOptions {
  baseUrl: string;
  defaultHeaders?: Record<string, string>;
  defaultTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const ABSOLUTE_URL = /^https?:\/\//i;

/**
 * Resolve a request path against the target base URL. An absolute http(s) path
 * is allowed only when its origin equals the base URL's origin (spec Section
 * 9.4) — this is what lets a scenario replay a `Location` extracted from a
 * manual-redirect step as the next request; a cross-origin one is refused.
 */
function resolveTarget(baseUrl: string, path: string): URL {
  if (ABSOLUTE_URL.test(path)) {
    const requested = new URL(path);
    const targetOrigin = new URL(baseUrl).origin;
    if (requested.origin !== targetOrigin) {
      throw new RequestShapeError(
        `request path origin '${requested.origin}' does not match the target base URL origin '${targetOrigin}': absolute paths must stay same-origin (spec Section 9.4)`,
      );
    }
    return requested;
  }
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return new URL(base + suffix);
}

/**
 * Join a base URL and request path, then append query parameters. A leading
 * slash on the path is preserved without dropping a base path prefix (unlike
 * `new URL(path, base)`). An absolute same-origin path is used as-is, query
 * string included. Null query values are omitted.
 */
export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean | null>,
): string {
  const url = resolveTarget(baseUrl, path);
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

/**
 * Refuse a request whose body cannot be shaped as specified. The scenario schema
 * rejects both cases at load time; this is the client's defensive net for a spec
 * that did not come from a validated scenario.
 */
function assertRequestShape(spec: HttpRequestSpec): void {
  if (spec.body !== undefined && spec.form !== undefined) {
    throw new RequestShapeError(
      'request sets both body and form; they are mutually exclusive (spec Section 9.6)',
    );
  }
  const hasBody = spec.body !== undefined || spec.form !== undefined;
  if (hasBody && BODYLESS_METHODS.has(spec.method)) {
    throw new RequestShapeError(
      `method ${spec.method} must not carry a body or form (spec Section 9.1)`,
    );
  }
}

/**
 * Serialize the request body — urlencoded for `form`, JSON for objects, verbatim
 * for strings — defaulting the content-type only when the caller did not set one.
 */
function applyBody(init: RequestInit, headers: Headers, spec: HttpRequestSpec): void {
  if (spec.form !== undefined) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(spec.form)) {
      params.append(key, String(value));
    }
    init.body = params.toString();
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/x-www-form-urlencoded');
    }
    return;
  }
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
    assertRequestShape(spec);
    url = buildUrl(options.baseUrl, spec.path, spec.query);
    const headers = buildHeaders(options.defaultHeaders, spec.headers);
    const init: RequestInit = {
      method: spec.method,
      headers,
      signal: controller.signal,
      // Default `follow` matches fetch; `manual` surfaces the 30x itself so a
      // scenario can inspect its Location and cookies (spec Section 9.3).
      redirect: spec.followRedirects === false ? 'manual' : 'follow',
    };
    applyBody(init, headers, spec);

    const response = await fetch(url, init);
    const bodyText = await response.text();
    const durationMs = performance.now() - start;
    return {
      status: response.status,
      headers: headersToObject(response.headers),
      // Plain iteration exposes only the last Set-Cookie; this is the lossless
      // capture (spec Section 9.2).
      setCookie: response.headers.getSetCookie(),
      bodyText,
      bodyJson: tryParseJson(bodyText),
      durationMs,
    };
  } catch (error) {
    const durationMs = performance.now() - start;
    const aborted = error instanceof Error && error.name === 'AbortError';
    const shape = error instanceof RequestShapeError;
    const target = url || `${options.baseUrl}${spec.path}`;
    return {
      status: 0,
      headers: {},
      setCookie: [],
      bodyText: '',
      durationMs,
      error: {
        type: aborted ? 'timeout' : shape ? 'request' : 'network',
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
