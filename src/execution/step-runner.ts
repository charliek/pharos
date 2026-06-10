import { type CompareRequest, type CustomComparator, compare } from '../comparison/compare';
import type { ComparisonResult } from '../comparison/result';
import type { ComparisonRules } from '../comparison/rules';
import type { PharosConfig } from '../config/config';
import { inlineComparisonRules } from '../contract/merge';
import { ValidationError } from '../errors';
import { writeFailureArtifacts } from '../reporting/artifacts';
import type { Scenario, ScenarioStep } from '../scenarios/schema';
import { buildRecording, loadRecording, recordingResponse, writeRecording } from './fixtures';
import type {
  HttpClientOptions,
  HttpRequestSpec,
  HttpResponseRecord,
  sendRequest,
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

export interface StepRunnerDeps {
  send: SendFn;
  /** Custom comparators by name (the hook registry, wired in the hooks phase). */
  comparators?: Record<string, CustomComparator>;
  /** Whether legacy_record steps may write recordings (record command / opt-in). */
  recordingEnabled?: boolean;
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

function clientOptions(side: 'legacy' | 'new', config: PharosConfig): HttpClientOptions {
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
  return {
    method: request.method,
    path: substituteText(request.path, ctx),
    query,
    headers,
    body: request.body === undefined ? undefined : substituteValue(request.body, ctx),
    timeoutMs: request.timeoutMs,
  };
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
  const legacy = await deps.send(clientOptions('legacy', config), spec);
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
    environment: config.output_mode,
    request: spec,
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
  let candidate: HttpResponseRecord | undefined;
  if (scenario.mode === 'replay_against_recording') {
    if (!step.recording) {
      return executionFailure(step, `step '${step.id}': replay requires a recording fixture`);
    }
    try {
      legacy = recordingResponse(loadRecording(config.fixture_dir, step.recording.fixture));
    } catch (error) {
      const detail = error instanceof ValidationError ? error.issues[0]?.message : messageOf(error);
      return executionFailure(step, `step '${step.id}': ${detail ?? messageOf(error)}`);
    }
    // Send the scenario's request (freshly variable-substituted, so it carries
    // current auth); the recording supplies the legacy *response* to compare
    // against. The recorded request is redacted and so is not replayed.
    candidate = await deps.send(clientOptions('new', config), spec);
  } else if (scenario.mode === 'compare_live') {
    // Independent reads against the shared store — issue them concurrently.
    [legacy, candidate] = await Promise.all([
      deps.send(clientOptions('legacy', config), spec),
      deps.send(clientOptions('new', config), spec),
    ]);
  } else {
    // new_only_assert
    candidate = await deps.send(clientOptions('new', config), spec);
  }

  if (candidate?.error)
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

  if (!candidate) {
    return executionFailure(step, `step '${step.id}': no response available to compare`, legacy);
  }
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

  const request: CompareRequest = {
    strategy: step.compare.strategy,
    rules: withConfiguredRedaction(scenarioRules ?? inlineComparisonRules(step.compare), config),
    legacy,
    candidate,
    statusSame: step.compare.status === 'same',
    requireMatchingPaths: step.compare.body?.require_matching_paths,
    expect: step.compare.expect,
    comparator,
    comparatorArgs: step.compare.args,
    sensitiveHeaders: config.redaction.headers,
  };
  const comparison = compare(request);

  let artifactDir: string | undefined;
  if (!comparison.pass) {
    artifactDir = writeFailureArtifacts(
      config.report_dir,
      scenario.id,
      step.id,
      { request: spec, legacy, candidate, diffText: comparison.diffText },
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
