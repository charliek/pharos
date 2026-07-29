// See hooks/index.ts for why this repo's own hooks import the public barrel by
// relative path; a scaffolded target repo imports from the package name,
// `'pharos'` (spec Section 19.1).
import { type HookContext, HookError, type HookFn, type HookOutput } from '../src/index';

/**
 * Example auth hook (spec Sections 3.5, 7.2, 19.1) — a template, not part of
 * this repo's active hook registry. It is registered nowhere by default (not
 * merged into `hooks/index.ts`'s `hooks` map); a target repo copies the
 * pattern into its own `hooks/index.ts` and adapts the request shape to its
 * login endpoint.
 *
 * ## The pattern: a `setup` hook establishes a session out-of-band
 *
 * A scenario's `setup.hooks` run once, before any step, and are not
 * themselves compared, extracted from, or subject to a step's
 * `follow_redirects` — they are plain code the hook author owns. That makes
 * `setup` the natural place for "log in, then assert against the resulting
 * session" scenarios: do the login as an ordinary `fetch` here, and return
 * whatever later steps need via an `assign` mapping (the same mechanism a
 * step's `before`/`after` hooks use, spec Section 7.2):
 *
 * ```yaml
 * setup:
 *   hooks:
 *     - name: passwordSessionLogin
 *       args: { email: '{{testUserEmail}}', password: '{{testUserPassword}}' }
 *       assign:
 *         sessionCookie: sessionCookie   # scenario variable <- hook output key
 *         userId: userId
 * steps:
 *   - id: get-profile
 *     request:
 *       method: GET
 *       path: /profile
 *       headers:
 *         cookie: '{{sessionCookie}}'
 * ```
 *
 * ## What a hook's `fetch` does *not* get for free
 *
 * A hook's HTTP call runs outside the step pipeline, so it does not inherit
 * step machinery:
 *
 * - No `follow_redirects`, default headers, or timeout from Pharos config —
 *   the hook builds its own request.
 * - **The scenario's cookie jar (`cookies: true`, spec Section 9.5) does not
 *   see it.** The jar only ingests `Set-Cookie` from requests the step
 *   runner itself issues, so a hook-driven login's session cookie is
 *   invisible to it. Two ways to carry a session from a hook into later
 *   steps:
 *   1. **Prefer this when the login itself needs no comparison/extraction**:
 *      extract the `Set-Cookie` value here (as below) and thread it through
 *      an `assign`'d variable into each step's `request.headers.cookie`
 *      explicitly.
 *   2. If the login response *is* part of what the scenario verifies, issue
 *      it as a normal step instead (with `cookies: true` scenario-wide) so
 *      the runner's own jar picks it up automatically — a hook is the wrong
 *      tool for that case.
 */

interface PasswordLoginArgs {
  /** Login endpoint base URL; falls back to `ctx.newBaseUrl`, then `NEW_BASE_URL`. */
  baseUrl?: string;
  email: string;
  password: string;
}

function isPasswordLoginArgs(value: unknown): value is PasswordLoginArgs {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as PasswordLoginArgs;
  return (
    typeof candidate.email === 'string' &&
    typeof candidate.password === 'string' &&
    (candidate.baseUrl === undefined || typeof candidate.baseUrl === 'string')
  );
}

/**
 * Log in against `${baseUrl}/login` with a JSON `{ email, password }` body and
 * return the session cookie (and, if present, the created user id) for
 * `assign`. Throws a {@link HookError} on any failure — an unmet hook
 * precondition should fail the scenario loudly, not proceed with a missing
 * session.
 */
export const passwordSessionLogin: HookFn = async (
  ctx: HookContext,
  args?: unknown,
): Promise<HookOutput> => {
  if (!isPasswordLoginArgs(args)) {
    throw new HookError('passwordSessionLogin: args.email and args.password are required');
  }
  const baseUrl = args.baseUrl ?? ctx.newBaseUrl ?? ctx.env.NEW_BASE_URL;
  if (!baseUrl) {
    throw new HookError(
      'passwordSessionLogin: no base URL (pass args.baseUrl, or set ctx.newBaseUrl / NEW_BASE_URL)',
    );
  }

  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: args.email, password: args.password }),
  });
  if (!response.ok) {
    throw new HookError(`passwordSessionLogin: login returned status ${response.status}`);
  }

  // `getSetCookie()` captures every Set-Cookie header losslessly (spec Section
  // 9.2) — the same API the HTTP client itself uses, so a hook's cookie
  // handling matches the rest of the harness even though the jar can't see it.
  const sessionSetCookie = response.headers
    .getSetCookie()
    .find((raw) => raw.startsWith('session='));
  if (!sessionSetCookie) {
    throw new HookError('passwordSessionLogin: response set no session cookie');
  }
  // The `name=value` pair only — attributes (Path, Max-Age, ...) are not part
  // of what a later step replays as a `Cookie` request header.
  const sessionCookie = sessionSetCookie.split(';', 1)[0] ?? '';

  let userId: string | undefined;
  try {
    const body = (await response.json()) as { userId?: string };
    userId = body.userId;
  } catch {
    // The login response is not guaranteed to carry a body; sessionCookie
    // alone is still a usable result.
  }

  return { sessionCookie, userId };
};

export const hooks = { passwordSessionLogin };
