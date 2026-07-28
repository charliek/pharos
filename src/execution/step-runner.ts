import {
  type CompareRequest,
  type CustomComparator,
  compare,
  type ExpectSpec,
} from '../comparison/compare';
import type {
  ExpectedAttribute,
  ExpectedCookie,
  ExpectedLocation,
} from '../comparison/expectations';
import type { ComparisonResult } from '../comparison/result';
import type { ComparisonRules } from '../comparison/rules';
import type { PharosConfig } from '../config/config';
import { inlineComparisonRules } from '../contract/merge';
import { ValidationError } from '../errors';
import { writeFailureArtifacts } from '../reporting/artifacts';
import type { Scenario, ScenarioStep } from '../scenarios/schema';
import type { CookieJar } from './cookies';
import {
  buildRecording,
  loadRecording,
  type Recording,
  recordingResponse,
  writeRecording,
} from './fixtures';
import {
  buildUrl,
  type HttpClientOptions,
  type HttpRequestSpec,
  type HttpResponseRecord,
  type sendRequest,
} from './http-client';
import {
  extractValue,
  substituteText,
  substituteValue,
  type VariableContext,
  VariableError,
} from './variables';

export interface StepResult {
  stepId: string;
  name?: string;
  pass: boolean;
  comparison?: ComparisonResult;
  legacy?: HttpResponseRecord;
  candidate?: HttpResponseRecord;
  /** Execution error (variable resolution, network) — distinct from a behavioral mismatch. */
  error?: string;
  artifactDir?: string;
  /** Path written for a legacy_record step (when recording is enabled). */
  recordingPath?: string;
  /** True for a legacy_record step that did not write because recording is disabled. */
  recordingSkipped?: boolean;
}

export type SendFn = typeof sendRequest;

/** The two sides a step can address. */
export type Target = 'legacy' | 'new';

/** The scenario run's cookie jars, one per target; absent as a whole for `cookies: false`. */
export type CookieJars = Record<Target, CookieJar>;

export interface StepRunnerDeps {
  send: SendFn;
  /** Custom comparators by name (the hook registry, wired in the hooks phase). */
  comparators?: Record<string, CustomComparator>;
  /** Whether legacy_record steps may write recordings (record command / opt-in). */
  recordingEnabled?: boolean;
  /** Per-target cookie jars when the scenario set `cookies: true` (spec Section 9.5). */
  cookieJars?: CookieJars;
}

/**
 * Augment the comparison rules with the operator's configured secret JSON paths
 * (config.redaction.json_paths). Applying them as redact_paths masks those
 * values during normalization, so an operator-declared secret can never reach
 * the diff text — closing the gap between behavioral (contract) redaction and
 * operational (config) redaction.
 */
function withConfiguredRedaction(rules: ComparisonRules, config: PharosConfig): ComparisonRules {
  if (config.redaction.json_paths.length === 0) return rules;
  return {
    ...rules,
    json: {
      ...rules.json,
      redact_paths: [...rules.json.redact_paths, ...config.redaction.json_paths],
    },
  };
}

function clientOptions(side: Target, config: PharosConfig): HttpClientOptions {
  const baseUrl = side === 'legacy' ? config.legacy_base_url : config.new_base_url;
  if (!baseUrl) {
    // Guarded by assertConfigForModes before a run starts; defensive here.
    throw new Error(`missing ${side}_base_url for mode execution`);
  }
  return {
    baseUrl,
    defaultHeaders: config.default_headers,
    defaultTimeoutMs: config.default_timeout_ms,
  };
}

function coerceQueryValue(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return String(value);
}

/** Resolve all template variables in a step's request into a concrete spec. */
function resolveRequest(step: ScenarioStep, ctx: VariableContext): HttpRequestSpec {
  const request = step.request;
  const query = request.query
    ? Object.fromEntries(
        Object.entries(request.query).map(([key, value]) => [
          key,
          typeof value === 'string' ? coerceQueryValue(substituteValue(value, ctx)) : value,
        ]),
      )
    : undefined;
  const headers = request.headers
    ? Object.fromEntries(
        Object.entries(request.headers).map(([key, value]) => [key, substituteText(value, ctx)]),
      )
    : undefined;
  // A form is urlencoded, so every value ends up a string anyway — substitute
  // like a header rather than preserving the resolved variable's type.
  const form = request.form
    ? Object.fromEntries(
        Object.entries(request.form).map(([key, value]) => [
          key,
          typeof value === 'string' ? substituteText(value, ctx) : value,
        ]),
      )
    : undefined;
  return {
    method: request.method,
    path: substituteText(request.path, ctx),
    query,
    headers,
    body: request.body === undefined ? undefined : substituteValue(request.body, ctx),
    form,
    followRedirects: request.follow_redirects,
    timeoutMs: request.timeoutMs,
  };
}

/** Substitute a string-valued attribute, preserving type for a whole-string template. */
function substituteAttribute(value: ExpectedAttribute, ctx: VariableContext): ExpectedAttribute {
  if (typeof value !== 'string') return value;
  const resolved = substituteValue(value, ctx);
  return typeof resolved === 'string' ||
    typeof resolved === 'number' ||
    typeof resolved === 'boolean'
    ? resolved
    : String(resolved);
}

function substituteExpectedCookie(cookie: ExpectedCookie, ctx: VariableContext): ExpectedCookie {
  return {
    ...cookie,
    name: substituteText(cookie.name, ctx),
    value: cookie.value !== undefined ? substituteText(cookie.value, ctx) : undefined,
    attributes: cookie.attributes
      ? Object.fromEntries(
          Object.entries(cookie.attributes).map(([name, value]) => [
            name,
            substituteAttribute(value, ctx),
          ]),
        )
      : undefined,
  };
}

function substituteExpectedLocation(
  location: ExpectedLocation,
  ctx: VariableContext,
): ExpectedLocation {
  return {
    ...location,
    path: location.path !== undefined ? substituteText(location.path, ctx) : undefined,
    query: location.query
      ? Object.fromEntries(
          Object.entries(location.query).map(([name, value]) => [name, substituteText(value, ctx)]),
        )
      : undefined,
    query_present: location.query_present?.map((name) => substituteText(name, ctx)),
    query_absent: location.query_absent?.map((name) => substituteText(name, ctx)),
  };
}

/**
 * Resolve template variables inside an `explicit_expectations` block (spec
 * Section 4.7's substitution paragraph / Section 7.1). `expect.status` stays
 * literal — it is compared as an already-typed integer, never templated. Every
 * other string leaf is substituted with the same engine `resolveRequest` uses,
 * evaluated by the caller *after* this step's own extraction, so an assertion
 * can reference a value the same step just captured.
 */
function substituteExpect(expect: ExpectSpec, ctx: VariableContext): ExpectSpec {
  const jsonPaths = expect.body?.json_paths;
  return {
    ...expect,
    headers: expect.headers
      ? Object.fromEntries(
          Object.entries(expect.headers).map(([name, value]) => [name, substituteText(value, ctx)]),
        )
      : undefined,
    header_absent: expect.header_absent?.map((name) => substituteText(name, ctx)),
    header_present: expect.header_present?.map((name) => substituteText(name, ctx)),
    body: jsonPaths
      ? {
          json_paths: Object.fromEntries(
            Object.entries(jsonPaths).map(([path, value]) => [
              path,
              typeof value === 'string' ? substituteValue(value, ctx) : value,
            ]),
          ),
        }
      : expect.body,
    set_cookie: expect.set_cookie?.map((cookie) => substituteExpectedCookie(cookie, ctx)),
    set_cookie_absent: expect.set_cookie_absent?.map((name) => substituteText(name, ctx)),
    location: expect.location ? substituteExpectedLocation(expect.location, ctx) : undefined,
  };
}

interface SentRequest {
  /** The spec as actually sent — including a jar-built `Cookie` header, if any. */
  spec: HttpRequestSpec;
  response: HttpResponseRecord;
  /**
   * The absolute URL the request resolved to; a relative `Location` in the
   * response resolves against it (spec Section 8.6). Undefined when the path did
   * not resolve at all (a cross-origin absolute path, which the client refuses).
   */
  url?: string;
}

function hasExplicitCookieHeader(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === 'cookie');
}

/**
 * The absolute URL a spec resolves to, or undefined when it does not resolve at
 * all (a cross-origin absolute path, which the client refuses). Only the jar
 * needs this up front — the send itself resolves the URL again and reports the
 * real error.
 */
function resolvedRequestUrl(
  baseUrl: string,
  path: string,
  query?: HttpRequestSpec['query'],
): string | undefined {
  try {
    return buildUrl(baseUrl, path, query);
  } catch {
    return undefined;
  }
}

/**
 * Send one request to one target, wrapping the call in that target's cookie jar
 * (spec Section 9.5). The jar supplies a `Cookie` header unless the step declared
 * its own — an explicit header replaces the jar's for sending — and ingests the
 * response's `Set-Cookie` either way. A manual-redirect 30x is an ordinary
 * response here, so its cookies land in the jar like any other hop.
 */
async function sendToTarget(
  side: Target,
  config: PharosConfig,
  spec: HttpRequestSpec,
  deps: StepRunnerDeps,
): Promise<SentRequest> {
  const options = clientOptions(side, config);
  const jar = deps.cookieJars?.[side];
  // The resolved URL serves the jar (path matching) and comparison (a relative
  // `Location` resolves against it). A path that does not resolve gets neither.
  const requestUrl = resolvedRequestUrl(options.baseUrl, spec.path, spec.query);
  if (!jar || requestUrl === undefined) {
    return { spec, response: await deps.send(options, spec), url: requestUrl };
  }
  let sent = spec;
  if (!hasExplicitCookieHeader(spec.headers)) {
    const cookie = jar.cookieHeader(requestUrl);
    if (cookie) sent = { ...spec, headers: { ...spec.headers, Cookie: cookie } };
  }
  const response = await deps.send(options, sent);
  jar.ingest(response.setCookie, requestUrl);
  return { spec: sent, response, url: requestUrl };
}

function executionFailure(
  step: ScenarioStep,
  message: string,
  legacy?: HttpResponseRecord,
  candidate?: HttpResponseRecord,
): StepResult {
  return { stepId: step.id, name: step.name, pass: false, error: message, legacy, candidate };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Apply a step's extractions into the shared variable store; returns a failure result on error. */
function applyExtraction(
  step: ScenarioStep,
  ctx: VariableContext,
  legacy: HttpResponseRecord | undefined,
  candidate: HttpResponseRecord | undefined,
): StepResult | undefined {
  if (!step.extract) return undefined;
  try {
    for (const [name, rule] of Object.entries(step.extract)) {
      ctx.variables[name] = extractValue(rule, { legacy, candidate });
    }
  } catch (error) {
    if (error instanceof VariableError) {
      return executionFailure(step, `step '${step.id}': ${error.message}`, legacy, candidate);
    }
    throw error;
  }
  return undefined;
}

/** Record a legacy interaction to a fixture (legacy_record mode); never compares. */
async function runRecordStep(
  scenario: Scenario,
  step: ScenarioStep,
  ctx: VariableContext,
  config: PharosConfig,
  spec: HttpRequestSpec,
  deps: StepRunnerDeps,
): Promise<StepResult> {
  const { spec: sentSpec, response: legacy } = await sendToTarget('legacy', config, spec, deps);
  if (legacy.error) {
    return executionFailure(step, `legacy request failed: ${legacy.error.message}`, legacy);
  }
  const extractionError = applyExtraction(step, ctx, legacy, undefined);
  if (extractionError) return extractionError;
  if (!step.recording) {
    return executionFailure(
      step,
      `step '${step.id}': legacy_record requires a recording fixture`,
      legacy,
    );
  }
  if (!deps.recordingEnabled) {
    return { stepId: step.id, name: step.name, pass: true, legacy, recordingSkipped: true };
  }
  const recording = buildRecording({
    scenarioId: scenario.id,
    stepId: step.id,
    recordedAt: new Date().toISOString(),
    environment: config.environment,
    request: sentSpec,
    response: legacy,
    safeHeaders: step.recording.safe_headers ?? [],
    redaction: config.redaction,
  });
  const recordingPath = writeRecording(config.fixture_dir, step.recording.fixture, recording);
  return { stepId: step.id, name: step.name, pass: true, legacy, recordingPath };
}

/** Execute one scenario step end to end (spec Section 3.3). */
export async function runStep(
  scenario: Scenario,
  step: ScenarioStep,
  ctx: VariableContext,
  config: PharosConfig,
  scenarioRules: ComparisonRules | undefined,
  deps: StepRunnerDeps,
): Promise<StepResult> {
  let spec: HttpRequestSpec;
  try {
    spec = resolveRequest(step, ctx);
  } catch (error) {
    if (error instanceof VariableError)
      return executionFailure(step, `step '${step.id}': ${error.message}`);
    throw error;
  }

  // Recording mode captures the legacy interaction and never compares.
  if (scenario.mode === 'legacy_record') {
    return runRecordStep(scenario, step, ctx, config, spec, deps);
  }

  let legacy: HttpResponseRecord | undefined;
  /** The URL the legacy request went to — the base a relative `Location` resolves against. */
  let legacyRequestUrl: string | undefined;
  // The new-side send is kept whole because failure artifacts record its `spec`
  // — the request as actually sent, so a jar-built `Cookie` header shows up
  // (redacted) instead of being invisible. Artifacts carry one request, as they
  // always have; with a jar the legacy side differs only in that header. Every
  // mode must assign it, which is what makes a candidate response guaranteed.
  let sentNew: SentRequest;
  if (scenario.mode === 'replay_against_recording') {
    if (!step.recording) {
      return executionFailure(step, `step '${step.id}': replay requires a recording fixture`);
    }
    let recording: Recording;
    try {
      recording = loadRecording(config.fixture_dir, step.recording.fixture);
      legacy = recordingResponse(recording);
    } catch (error) {
      const detail = error instanceof ValidationError ? error.issues[0]?.message : messageOf(error);
      return executionFailure(step, `step '${step.id}': ${detail ?? messageOf(error)}`);
    }
    // A relative `Location` in the recorded response was written relative to the
    // URL the *recorded* request went to (spec Section 8.6) — which is the
    // recording's own path, not the live step's: a parameterized replay can send
    // a different path entirely, and resolving against that would invent a
    // redirect target the legacy service never named. The recorded query is
    // deliberately not applied: it is redacted on disk, and a base URL's query
    // never participates in resolving a relative reference. With no legacy base
    // URL configured (replay does not require one), or a recorded path that does
    // not resolve against it, the base is absent and the comparison takes the
    // exact-string fallback.
    legacyRequestUrl = config.legacy_base_url
      ? resolvedRequestUrl(config.legacy_base_url, recording.request.path)
      : undefined;
    // Send the scenario's request (freshly variable-substituted, so it carries
    // current auth); the recording supplies the legacy *response* to compare
    // against. The recorded request is redacted and so is not replayed.
    sentNew = await sendToTarget('new', config, spec, deps);
  } else if (scenario.mode === 'compare_live') {
    // Independent reads against the shared store — issue them concurrently. The
    // two targets have independent jars, so concurrency cannot cross-contaminate.
    const [legacySent, newSent] = await Promise.all([
      sendToTarget('legacy', config, spec, deps),
      sendToTarget('new', config, spec, deps),
    ]);
    legacy = legacySent.response;
    legacyRequestUrl = legacySent.url;
    sentNew = newSent;
  } else {
    // new_only_assert
    sentNew = await sendToTarget('new', config, spec, deps);
  }
  const candidate = sentNew.response;

  if (candidate.error)
    return executionFailure(
      step,
      `new request failed: ${candidate.error.message}`,
      legacy,
      candidate,
    );
  if (legacy?.error)
    return executionFailure(
      step,
      `legacy request failed: ${legacy.error.message}`,
      legacy,
      candidate,
    );

  // Extraction runs before comparison and feeds later steps (spec Section 4.6).
  const extractionError = applyExtraction(step, ctx, legacy, candidate);
  if (extractionError) return extractionError;

  if (!step.compare) {
    return executionFailure(
      step,
      `step '${step.id}': mode '${scenario.mode}' requires a compare block`,
      legacy,
      candidate,
    );
  }

  const comparator =
    step.compare.strategy === 'custom'
      ? deps.comparators?.[step.compare.comparator ?? '']
      : undefined;
  if (step.compare.strategy === 'custom' && !comparator) {
    return executionFailure(
      step,
      `step '${step.id}': no comparator named '${step.compare.comparator}' is registered`,
      legacy,
      candidate,
    );
  }

  // Expectation values are templated at evaluation time (spec Section 4.7),
  // i.e. after the extraction above — so an expect.* value can reference a
  // variable this same step just captured, not only an earlier one's.
  let expect: ExpectSpec | undefined;
  try {
    expect = step.compare.expect ? substituteExpect(step.compare.expect, ctx) : undefined;
  } catch (error) {
    if (error instanceof VariableError)
      return executionFailure(step, `step '${step.id}': ${error.message}`, legacy, candidate);
    throw error;
  }

  const request: CompareRequest = {
    strategy: step.compare.strategy,
    rules: withConfiguredRedaction(scenarioRules ?? inlineComparisonRules(step.compare), config),
    legacy,
    candidate,
    statusSame: step.compare.status === 'same',
    requireMatchingPaths: step.compare.body?.require_matching_paths,
    expect,
    comparator,
    comparatorArgs: step.compare.args,
    sensitiveHeaders: config.redaction.headers,
    sensitiveQueryParams: config.redaction.query_params,
    legacyRequestUrl,
    candidateRequestUrl: sentNew.url,
  };
  const comparison = compare(request);

  let artifactDir: string | undefined;
  if (!comparison.pass) {
    artifactDir = writeFailureArtifacts(
      config.report_dir,
      scenario.id,
      step.id,
      { request: sentNew.spec, legacy, candidate, diffText: comparison.diffText },
      config.redaction,
    );
  }
  return {
    stepId: step.id,
    name: step.name,
    pass: comparison.pass,
    comparison,
    legacy,
    candidate,
    artifactDir,
  };
}
