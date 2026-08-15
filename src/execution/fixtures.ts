import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { z } from 'zod';
import { redactJsonValue, redactQuery, redactUrl } from '../comparison/redaction';
import { maskError, maskText, maskValue, type SensitiveValues } from '../comparison/sensitive';
import type { RedactionTargets } from '../config/config';
import { readDocumentFile } from '../document';
import { ValidationError, validateWithSchema } from '../errors';
import { HTTP_METHODS, type HttpRequestSpec, type HttpResponseRecord } from './http-client';

/**
 * Recording fixtures (spec Section 10). A recording captures a legacy
 * interaction as JSON for later replay against the new service. Recordings are
 * redacted before being written — only `safe_headers` are persisted and
 * configured secret JSON paths are masked — so no secret reaches a fixture.
 */

const recordingRequestSchema = z
  .object({
    method: z.enum(HTTP_METHODS),
    path: z.string(),
    query: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    headers: z.record(z.string()).optional(),
    body: z.unknown().optional(),
    timeoutMs: z.number().optional(),
  })
  .strict();

/**
 * The on-disk response shape (spec Sections 9 and 10.1). It deliberately differs
 * from the in-memory `HttpResponseRecord`: `set_cookie` is snake_case (the
 * recording format's convention) and **optional**, since every recording made
 * before cookie capture existed has none — absent means "no cookie data was
 * captured", not "no cookies were set". Re-record to add it.
 */
const recordingResponseSchema = z
  .object({
    status: z.number(),
    headers: z.record(z.string()),
    set_cookie: z.array(z.string()).optional(),
    bodyText: z.string(),
    bodyJson: z.unknown().optional(),
    durationMs: z.number(),
    error: z.object({ type: z.string(), message: z.string() }).optional(),
  })
  .strict();

export const recordingSchema = z
  .object({
    version: z.literal(1),
    scenarioId: z.string(),
    stepId: z.string(),
    recordedAt: z.string(),
    environment: z.string().optional(),
    request: recordingRequestSchema,
    response: recordingResponseSchema,
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export type Recording = z.infer<typeof recordingSchema>;

export interface BuildRecordingParams {
  scenarioId: string;
  stepId: string;
  recordedAt: string;
  environment?: string;
  request: HttpRequestSpec;
  response: HttpResponseRecord;
  /** Header names allowed into the recording; all others are dropped. */
  safeHeaders: string[];
  redaction: RedactionTargets;
  /**
   * Values extracted from secret-bearing sources during this scenario run (spec
   * Section 8.5). Masked out of the recording — request *and* response — even
   * where `safe_headers` would otherwise persist them.
   */
  sensitive?: SensitiveValues;
}

function keepSafeHeaders(
  headers: Record<string, string> | undefined,
  safe: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (safe.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

// Only JSON object/array bodies can be path-redacted; scalars and non-JSON text
// are not persisted (replaced with a note) so an unredactable secret never
// reaches a fixture. Replay therefore covers JSON object/array bodies.
const NON_RECORDABLE_BODY =
  '[non-JSON or scalar body omitted to avoid leaking unredactable content]';

function recordableBody(body: unknown, paths: string[]): unknown {
  if (body === undefined) return undefined;
  if (typeof body === 'object' && body !== null) return redactJsonValue(body, paths);
  return NON_RECORDABLE_BODY;
}

/**
 * Build a redacted {@link Recording}. Only safe headers survive; JSON object/array
 * bodies have their secret paths masked (and the cached text is regenerated to
 * match); query params are masked. Scalar and non-JSON bodies are not persisted —
 * they can't be path-redacted, so a note is stored instead.
 *
 * Extracted secret values (spec Section 8.5) are masked across the **whole**
 * recording, request and response alike, including a `safe_headers`-declared
 * `Set-Cookie`. That is deliberate and fails closed: a replay chain that only
 * works because a fixture stored a live credential is refused by construction —
 * the marker will not match the live service, so the replay fails loudly at the
 * comparison instead of quietly depending on a secret checked into the repo.
 * Re-record with a fresh credential rather than reaching for the raw value.
 */
export function buildRecording(params: BuildRecordingParams): Recording {
  const safe = new Set(params.safeHeaders.map((h) => h.toLowerCase()));
  const sensitive = params.sensitive;

  let bodyJson = params.response.bodyJson;
  let bodyText: string;
  if (bodyJson !== undefined && typeof bodyJson === 'object' && bodyJson !== null) {
    // Masked structurally, then re-serialized: masking `bodyText` after the
    // fact would miss any value the JSON encoder escaped.
    bodyJson = maskValue(redactJsonValue(bodyJson, params.redaction.json_paths), sensitive);
    bodyText = JSON.stringify(bodyJson);
  } else {
    bodyJson = undefined;
    bodyText = params.response.bodyText === '' ? '' : NON_RECORDABLE_BODY;
  }

  const requestBody = recordableBody(params.request.body, params.redaction.json_paths);

  return {
    version: 1,
    scenarioId: params.scenarioId,
    stepId: params.stepId,
    recordedAt: params.recordedAt,
    ...(params.environment ? { environment: params.environment } : {}),
    request: maskValue(
      {
        method: params.request.method,
        path: redactUrl(params.request.path, params.redaction.query_params),
        query: redactQuery(params.request.query, params.redaction.query_params),
        headers: keepSafeHeaders(params.request.headers, safe),
        body: requestBody,
        timeoutMs: params.request.timeoutMs,
      },
      sensitive,
    ),
    response: {
      status: params.response.status,
      headers: maskValue(keepSafeHeaders(params.response.headers, safe), sensitive),
      // Cookie values are secrets: they are persisted only when the scenario
      // declares set-cookie safe, the same discipline keepSafeHeaders applies —
      // and an extracted one is masked even then (see the doc comment).
      ...(safe.has('set-cookie')
        ? { set_cookie: params.response.setCookie.map((value) => maskText(value, sensitive)) }
        : {}),
      bodyText,
      bodyJson,
      durationMs: params.response.durationMs,
      ...(params.response.error ? { error: maskError(params.response.error, sensitive) } : {}),
    },
  };
}

/** Resolve a fixture path under `fixtureDir`, rejecting absolute paths and `..` escapes. */
function resolveFixturePath(fixtureDir: string, fixturePath: string): string {
  if (isAbsolute(fixturePath)) {
    throw new ValidationError(fixturePath, [
      { path: '(fixture)', message: 'fixture path must be relative to the fixture directory' },
    ]);
  }
  const base = resolve(fixtureDir);
  const full = resolve(base, fixturePath);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new ValidationError(fixturePath, [
      { path: '(fixture)', message: `fixture path escapes the fixture directory: ${fixturePath}` },
    ]);
  }
  return full;
}

/** Write a recording to `fixtureDir/fixturePath`, creating parent directories. */
export function writeRecording(
  fixtureDir: string,
  fixturePath: string,
  recording: Recording,
): string {
  const full = resolveFixturePath(fixtureDir, fixturePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `${JSON.stringify(recording, null, 2)}\n`);
  return full;
}

/** Load and validate a recording; a missing or invalid fixture fails clearly. */
export function loadRecording(fixtureDir: string, fixturePath: string): Recording {
  const full = resolveFixturePath(fixtureDir, fixturePath);
  if (!existsSync(full)) {
    throw new ValidationError(full, [
      { path: '(fixture)', message: `recording fixture not found: ${fixturePath}` },
    ]);
  }
  return validateWithSchema(recordingSchema, readDocumentFile(full), full);
}

/**
 * Verify a loaded recording was captured for the scenario/step now replaying it
 * (spec Section 10.3). `scenarioId`/`stepId` are stamped into the fixture at
 * record time (Section 10.1) but `loadRecording` only validates shape — nothing
 * otherwise stops a step from pointing at a fixture recorded for a different
 * scenario or step (wrong path typed, a scenario renamed after recording, two
 * fixtures swapped between steps). That's undetectable at replay without this
 * check and silently compares against the wrong oracle, so it fails closed: no
 * escape hatch. Re-record under the correct scenario/step instead.
 */
export function assertRecordingIdentity(
  recording: Recording,
  fixturePath: string,
  scenarioId: string,
  stepId: string,
): void {
  if (recording.scenarioId === scenarioId && recording.stepId === stepId) return;
  throw new ValidationError(fixturePath, [
    {
      path: '(fixture)',
      message:
        `recording identity mismatch for '${fixturePath}': ` +
        `expected scenario '${scenarioId}' step '${stepId}', ` +
        `recording was captured for scenario '${recording.scenarioId}' step '${recording.stepId}'`,
    },
  ]);
}

/**
 * The recorded legacy response, as an HttpResponseRecord for comparison. Maps
 * the on-disk optional `set_cookie` back to the required in-memory `setCookie`;
 * a recording without it replays with no cookie data (spec Section 10.1).
 */
export function recordingResponse(recording: Recording): HttpResponseRecord {
  const { set_cookie: setCookie = [], ...response } = recording.response;
  return { ...response, setCookie };
}
