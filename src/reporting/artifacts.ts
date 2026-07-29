import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactHeaders, redactJsonValue, redactQuery, redactUrl } from '../comparison/redaction';
import type { RedactionTargets } from '../config/config';
import type { HttpRequestSpec, HttpResponseRecord } from '../execution/http-client';

/**
 * Redacted failure artifacts (spec Section 11.4). On a failed comparison Pharos
 * writes the request, both responses, and the diff under the report directory —
 * always passed through redaction so no secret reaches disk (Section 8.5).
 */

export interface ArtifactInputs {
  request?: HttpRequestSpec;
  legacy?: HttpResponseRecord;
  candidate?: HttpResponseRecord;
  diffText?: string;
}

// Only JSON object/array bodies can be path-redacted; scalars and non-JSON text
// are omitted with a note so an unredactable secret never reaches disk.
const NON_JSON_NOTE = '[non-JSON or scalar body omitted to avoid leaking unredactable content]';

/**
 * Header names masked in artifacts no matter what the operator configured. The
 * cookie jar (spec Sections 4.6 and 9.5) puts session values Pharos itself
 * collected onto the wire, and the spec pins those to "redacted in every
 * rendered output" — so a config that drops `cookie` from `redaction.headers`
 * must not be able to expose jar contents on disk. These are unioned in rather
 * than replacing the configured list.
 */
const ALWAYS_REDACTED_HEADERS = ['cookie', 'set-cookie'];

/** Redact a body for an artifact: object/array via JSON paths, anything else omitted. */
function redactedBody(body: unknown, paths: string[]): unknown {
  if (body === undefined) return undefined;
  if (typeof body === 'object' && body !== null) return redactJsonValue(body, paths);
  return NON_JSON_NOTE;
}

function redactedResponse(response: HttpResponseRecord, redaction: RedactionTargets): unknown {
  const body =
    response.bodyJson !== undefined
      ? redactedBody(response.bodyJson, redaction.json_paths)
      : response.bodyText === ''
        ? ''
        : NON_JSON_NOTE;
  return {
    status: response.status,
    headers: redactHeaders(response.headers, redaction.headers),
    body,
    durationMs: response.durationMs,
    ...(response.error ? { error: response.error } : {}),
  };
}

function redactedRequest(request: HttpRequestSpec, redaction: RedactionTargets): unknown {
  return {
    method: request.method,
    path: redactUrl(request.path, redaction.query_params),
    query: redactQuery(request.query, redaction.query_params),
    headers: request.headers ? redactHeaders(request.headers, redaction.headers) : {},
    body: redactedBody(request.body, redaction.json_paths),
  };
}

function writeJson(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

/** Write the redacted artifacts for a failed step; returns the directory written. */
export function writeFailureArtifacts(
  reportDir: string,
  scenarioId: string,
  stepId: string,
  inputs: ArtifactInputs,
  redaction: RedactionTargets,
): string {
  const dir = join(reportDir, 'artifacts', scenarioId, stepId);
  mkdirSync(dir, { recursive: true });
  const safe: RedactionTargets = {
    ...redaction,
    headers: [...new Set([...redaction.headers, ...ALWAYS_REDACTED_HEADERS])],
  };
  if (inputs.request) writeJson(dir, 'request.json', redactedRequest(inputs.request, safe));
  if (inputs.legacy) writeJson(dir, 'legacy-response.json', redactedResponse(inputs.legacy, safe));
  if (inputs.candidate) {
    writeJson(dir, 'new-response.json', redactedResponse(inputs.candidate, safe));
  }
  if (inputs.diffText) writeFileSync(join(dir, 'diff.txt'), `${inputs.diffText}\n`);
  return dir;
}
