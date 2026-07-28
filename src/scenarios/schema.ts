import { z } from 'zod';
import { JsonPathError, parseJsonPath } from '../comparison/jsonpath';
import { jsonNormalizationSchema, jsonPathSchema } from '../comparison/rules';
import { BODYLESS_METHODS, HTTP_METHODS, type HttpMethod } from '../execution/http-client';

/**
 * Request methods a scenario may issue (spec Sections 4.6 and 9.1) — the client's
 * list, so a scenario can never name a method the client cannot send. OPTIONS and
 * HEAD are here for CORS-preflight and HEAD scenarios; both forbid a `body` and
 * a `form` (enforced below, and again defensively in the client). The contract's
 * `match.methods` is a separate, Limen-shared list — the two need not coincide.
 */
export const REQUEST_METHODS = HTTP_METHODS;
export type RequestMethod = HttpMethod;
const requestMethodSchema = z.enum(REQUEST_METHODS);

/** Add a field-addressed issue when `value` is not a supported JSONPath. */
function addJsonPathIssue(ctx: z.RefinementCtx, path: (string | number)[], value: string): void {
  try {
    parseJsonPath(value);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: error instanceof JsonPathError ? error.message : `invalid JSONPath '${value}'`,
    });
  }
}

/**
 * Zod schema and types for scenario specs (spec Section 4). Strict objects
 * reject unknown keys so typos surface as field-level errors. Cross-field rules
 * (per-mode requirements, the contract-vs-inline conflict, the destructive/safety
 * rule) live in the top-level `superRefine`.
 */

export const SCENARIO_MODES = [
  'compare_live',
  'legacy_record',
  'replay_against_recording',
  'new_only_assert',
] as const;
export type ScenarioMode = (typeof SCENARIO_MODES)[number];
export const modeSchema = z.enum(SCENARIO_MODES);

export const COMPARE_STRATEGIES = [
  'exact',
  'json_semantic',
  'subset',
  'explicit_expectations',
  'custom',
] as const;
export type CompareStrategy = (typeof COMPARE_STRATEGIES)[number];
export const strategySchema = z.enum(COMPARE_STRATEGIES);

const idSchema = z
  .string()
  .regex(
    /^[a-z0-9]+([-._/][a-z0-9]+)*$/,
    'id must be lowercase, dot/slash/dash separated (e.g. users.get-user-success)',
  );

const hookRefSchema = z
  .object({
    name: z.string().min(1),
    args: z.record(z.unknown()).optional(),
    assign: z.record(z.string()).optional(),
  })
  .strict();
const hooksBlockSchema = z.object({ hooks: z.array(hookRefSchema).optional() }).strict();

const requestSchema = z
  .object({
    method: requestMethodSchema,
    path: z.string().min(1),
    query: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    headers: z.record(z.string()).optional(),
    body: z.unknown().optional(),
    // Urlencoded body (spec Section 9.6); `follow_redirects` defaults to true
    // (spec Section 9.3) — both snake_case on disk, camelCase in the client.
    form: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
    follow_redirects: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.body !== undefined && request.form !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['form'],
        message: 'request.body and request.form are mutually exclusive — pick one body encoding',
      });
    }
    if (BODYLESS_METHODS.has(request.method)) {
      for (const field of ['body', 'form'] as const) {
        if (request[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `method ${request.method} must not set request.${field} (bodies on OPTIONS/HEAD are unreliable across HTTP implementations)`,
          });
        }
      }
    }
  });

const EXTRACT_SOURCES = [
  'legacy.body',
  'new.body',
  'response.body',
  'legacy.headers',
  'new.headers',
  'response.headers',
  'legacy.set_cookie',
  'new.set_cookie',
  'response.set_cookie',
] as const;
const extractRuleSchema = z
  .object({
    from: z.enum(EXTRACT_SOURCES),
    path: z.string().min(1),
  })
  .strict()
  .superRefine((rule, ctx) => {
    // Body extraction uses a JSONPath (subset); header extraction uses a header
    // name; set_cookie extraction uses a cookie name (spec Section 4.6).
    if (rule.from.endsWith('.body')) {
      addJsonPathIssue(ctx, ['path'], rule.path);
    }
  });

const headerRulesSchema = z
  .object({
    compare: z.array(z.string()).optional(),
    ignore: z.array(z.string()).optional(),
  })
  .strict();

// The inline body reuses the contract's normalization vocabulary verbatim (so
// the two can never drift) plus `require_matching_paths` for the subset strategy.
const compareBodySchema = jsonNormalizationSchema
  .extend({
    require_matching_paths: z.array(jsonPathSchema).optional(),
  })
  .strict();

const expectSchema = z
  .object({
    status: z.number().int().optional(),
    body: z
      .object({ json_paths: z.record(z.unknown()).optional() })
      .strict()
      .optional(),
  })
  .strict();

const compareSchema = z
  .object({
    strategy: strategySchema,
    status: z.literal('same').optional(),
    headers: headerRulesSchema.optional(),
    body: compareBodySchema.optional(),
    expect: expectSchema.optional(),
    comparator: z.string().optional(),
    args: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((compare, ctx) => {
    if (compare.strategy === 'subset') {
      if (!compare.body?.require_matching_paths?.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['body', 'require_matching_paths'],
          message: "strategy 'subset' requires compare.body.require_matching_paths",
        });
      }
    }
    if (compare.strategy === 'explicit_expectations') {
      if (!compare.expect) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['expect'],
          message: "strategy 'explicit_expectations' requires compare.expect",
        });
      } else {
        const jsonPaths = compare.expect.body?.json_paths;
        const hasStatus = compare.expect.status !== undefined;
        const hasBody = jsonPaths !== undefined && Object.keys(jsonPaths).length > 0;
        if (!hasStatus && !hasBody) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['expect'],
            message:
              "strategy 'explicit_expectations' must assert at least expect.status or a non-empty expect.body.json_paths",
          });
        }
        if (jsonPaths) {
          for (const key of Object.keys(jsonPaths)) {
            addJsonPathIssue(ctx, ['expect', 'body', 'json_paths', key], key);
          }
        }
      }
    }
    if (compare.strategy === 'custom' && !compare.comparator) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['comparator'],
        message: "strategy 'custom' requires compare.comparator (a named hook)",
      });
    }
  });

const recordingSchema = z
  .object({
    fixture: z.string().min(1),
    safe_headers: z.array(z.string()).optional(),
  })
  .strict();

const stepSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    request: requestSchema,
    extract: z.record(extractRuleSchema).optional(),
    recording: recordingSchema.optional(),
    compare: compareSchema.optional(),
    before: hooksBlockSchema.optional(),
    after: hooksBlockSchema.optional(),
  })
  .strict();

const safetySchema = z
  .object({
    destructive: z.boolean().optional(),
    requiresProductionGuardOverride: z.boolean().optional(),
    allowedEnvironments: z.array(z.string()).optional(),
  })
  .strict();

/**
 * The inline body fields that carry behavioral normalization (vs. comparison
 * structure like `require_matching_paths`). Single-sourced so it cannot drift
 * from the normalization vocabulary as the latter grows.
 */
const INLINE_BEHAVIORAL_BODY_FIELDS = [
  'ignore_paths',
  'redact_paths',
  'sort_arrays',
  'unordered_arrays',
  'normalize_timestamps',
  'enum_aliases',
] as const;

/** True when a step declares inline behavioral normalization (vs. comparison structure). */
function hasInlineBehavioralRules(step: z.infer<typeof stepSchema>): boolean {
  const headers = step.compare?.headers;
  if ((headers?.compare?.length ?? 0) > 0 || (headers?.ignore?.length ?? 0) > 0) {
    return true;
  }
  const body = step.compare?.body;
  if (!body) return false;
  return INLINE_BEHAVIORAL_BODY_FIELDS.some((field) => (body[field]?.length ?? 0) > 0);
}

export const scenarioSchema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    service: z.string().min(1),
    tags: z.array(z.string()).min(1, 'at least one tag is required'),
    mode: modeSchema,
    safety: safetySchema.optional(),
    contract: z.string().min(1).optional(),
    variables: z.record(z.unknown()).optional(),
    // Opt in to the per-target cookie jar for this scenario run (spec Sections
    // 4.6 and 9.5); default false = no jar, the scenario propagates cookies itself.
    cookies: z.boolean().optional(),
    setup: hooksBlockSchema.optional(),
    cleanup: hooksBlockSchema.optional(),
    steps: z.array(stepSchema).min(1),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    // Unique step ids.
    const seenStepIds = new Set<string>();
    scenario.steps.forEach((step, index) => {
      if (seenStepIds.has(step.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index, 'id'],
          message: `duplicate step id '${step.id}'`,
        });
      }
      seenStepIds.add(step.id);
    });

    // A scenario binds to one source of behavioral truth: a contract reference
    // OR inline behavioral rules, never both (spec Sections 4.7 and 5.4).
    if (scenario.contract) {
      scenario.steps.forEach((step, index) => {
        if (hasInlineBehavioralRules(step)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['steps', index, 'compare'],
            message:
              'a scenario cannot reference a contract and also declare inline behavioral rules (ignore_paths, sort_arrays, header compare/ignore, …) — pick one source of behavioral truth',
          });
        }
      });
    }

    // Per-mode structural requirements.
    scenario.steps.forEach((step, index) => {
      const at = (field: string) => ['steps', index, field] as (string | number)[];
      switch (scenario.mode) {
        case 'compare_live':
          if (!step.compare) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: at('compare'),
              message: "mode 'compare_live' requires a compare block on every step",
            });
          }
          break;
        case 'new_only_assert':
          if (!step.compare) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: at('compare'),
              message: "mode 'new_only_assert' requires a compare block on every step",
            });
          } else if (
            step.compare.strategy !== 'explicit_expectations' &&
            step.compare.strategy !== 'custom'
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: at('compare'),
              message:
                "mode 'new_only_assert' has only one response, so its strategy must be 'explicit_expectations' or 'custom'",
            });
          }
          if (step.extract) {
            for (const [name, rule] of Object.entries(step.extract)) {
              if (rule.from.startsWith('legacy.')) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: ['steps', index, 'extract', name, 'from'],
                  message: "mode 'new_only_assert' has no legacy response to extract from",
                });
              }
            }
          }
          break;
        case 'replay_against_recording':
          if (!step.recording) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: at('recording'),
              message: "mode 'replay_against_recording' requires a recording fixture on every step",
            });
          }
          if (!step.compare) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: at('compare'),
              message: "mode 'replay_against_recording' requires a compare block on every step",
            });
          }
          break;
        case 'legacy_record':
          if (!step.recording) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: at('recording'),
              message: "mode 'legacy_record' requires a recording fixture on every step",
            });
          }
          break;
      }
    });

    // A destructive scenario must declare its safety posture explicitly.
    if (scenario.tags.includes('destructive') && scenario.safety?.destructive !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['safety', 'destructive'],
        message: "a scenario tagged 'destructive' must set safety.destructive: true",
      });
    }
  });

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioStep = z.infer<typeof stepSchema>;
export type ScenarioRequest = z.infer<typeof requestSchema>;
export type ScenarioCompare = z.infer<typeof compareSchema>;
export type ExtractRule = z.infer<typeof extractRuleSchema>;
export type HookRef = z.infer<typeof hookRefSchema>;
export type ScenarioSafety = z.infer<typeof safetySchema>;
