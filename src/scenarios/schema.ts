import { z } from 'zod';
import { expectedCookieSchema, expectedLocationSchema } from '../comparison/expectations';
import { JsonPathError, parseJsonPath } from '../comparison/jsonpath';
import {
  dimensionHeaderConflictMessage,
  dimensionHeaderConflicts,
  jsonNormalizationSchema,
  jsonPathSchema,
  locationBlockSchema,
  setCookieBlockSchema,
} from '../comparison/rules';
import {
  BODYLESS_METHODS,
  conflictingFormContentType,
  FORM_MEDIA_TYPE,
  HTTP_METHODS,
  type HttpMethod,
} from '../execution/http-client';
import { containsTemplate } from '../execution/variables';

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
    // A GET `body`/`form` has no meaning (there is no urlencoded- or JSON-body
    // sense for a method that carries its data in the query string) and would
    // otherwise reach the client and `fetch` as a body on GET, producing a
    // confusing network-layer error (spec Sections 9.1 and 9.6).
    if (request.method === 'GET') {
      for (const field of ['body', 'form'] as const) {
        if (request[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `method GET must not set request.${field} (a GET ${field} has no meaning)`,
          });
        }
      }
    }
    // `request.form` always urlencodes and implies FORM_MEDIA_TYPE; an explicit
    // content-type header naming a different media type would ship a body
    // labeled as something it isn't, silently. Parameters (`; charset=utf-8`)
    // are fine — only the media type itself must match (spec Section 9.6).
    // This runs before the runner's variable substitution (spec Section 7.1),
    // so a templated value (`{{ variables.ct }}`) cannot be judged yet — skip
    // it here and let the client's post-substitution check (which sees the
    // resolved value) be the enforcement point for that case.
    if (request.form !== undefined) {
      const conflict = conflictingFormContentType(request.headers);
      if (conflict && !containsTemplate(conflict.headerValue)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['headers', conflict.headerName],
          message: `request.form implies content-type '${FORM_MEDIA_TYPE}', but request.headers.${conflict.headerName} sets '${conflict.headerValue}' — remove the header or correct it to match (spec Section 9.6)`,
        });
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

/**
 * Header names that must never be asserted through the single-value `headers`
 * map: `set-cookie` is multi-valued (the map keeps only the last one, spec
 * Section 9.2) and `cookie` carries secrets. Use `expect.set_cookie` instead.
 */
const COOKIE_HEADER_NAMES = new Set(['set-cookie', 'cookie']);

const expectSchema = z
  .object({
    status: z.number().int().optional(),
    headers: z.record(z.string()).optional(),
    header_absent: z.array(z.string()).optional(),
    header_present: z.array(z.string()).optional(),
    body: z
      .object({ json_paths: z.record(z.unknown()).optional() })
      .strict()
      .optional(),
    // The assertion engine's own schemas (spec Section 4.7), so the loader and
    // the engine cannot drift apart.
    set_cookie: z.array(expectedCookieSchema).optional(),
    set_cookie_absent: z.array(z.string().min(1)).optional(),
    location: expectedLocationSchema.optional(),
  })
  .strict()
  .superRefine((expect, ctx) => {
    const rejectCookieHeader = (path: (string | number)[], name: string): void => {
      if (!COOKIE_HEADER_NAMES.has(name.trim().toLowerCase())) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: `expect.headers/header_absent/header_present must not name '${name}' — the single-value headers map keeps only the last Set-Cookie (spec Section 9.2); assert cookies with expect.set_cookie/set_cookie_absent`,
      });
    };
    for (const name of Object.keys(expect.headers ?? {})) {
      rejectCookieHeader(['headers', name], name);
    }
    for (const [index, name] of (expect.header_absent ?? []).entries()) {
      rejectCookieHeader(['header_absent', index], name);
    }
    for (const [index, name] of (expect.header_present ?? []).entries()) {
      rejectCookieHeader(['header_present', index], name);
    }
    for (const [index, cookie] of (expect.set_cookie ?? []).entries()) {
      // Field *presence*, not truthiness: `{ value: abc, value_present: false }`
      // is the same confused intent as `value_present: true` beside a value, and
      // silently ignoring the `false` would assert something the author did not
      // write.
      if (cookie.value !== undefined && cookie.value_present !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['set_cookie', index, 'value_present'],
          message:
            'a cookie expectation asserts either an exact `value` or `value_present`, not both',
        });
      }
    }
  });

const compareSchema = z
  .object({
    strategy: strategySchema,
    status: z.literal('same').optional(),
    headers: headerRulesSchema.optional(),
    body: compareBodySchema.optional(),
    // The two opt-in dimensions, in the contract's vocabulary verbatim (spec
    // Section 8.6), so an inline scenario resolves them like a contract route.
    set_cookie: setCookieBlockSchema.optional(),
    location: locationBlockSchema.optional(),
    expect: expectSchema.optional(),
    comparator: z.string().optional(),
    args: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((compare, ctx) => {
    for (const name of dimensionHeaderConflicts(compare.headers?.compare, {
      set_cookie: Boolean(compare.set_cookie),
      location: Boolean(compare.location),
    })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headers', 'compare'],
        message: dimensionHeaderConflictMessage(name),
      });
    }
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
        const expect = compare.expect;
        const jsonPaths = expect.body?.json_paths;
        const asserts =
          expect.status !== undefined ||
          (jsonPaths !== undefined && Object.keys(jsonPaths).length > 0) ||
          Object.keys(expect.headers ?? {}).length > 0 ||
          (expect.header_absent?.length ?? 0) > 0 ||
          (expect.header_present?.length ?? 0) > 0 ||
          (expect.set_cookie?.length ?? 0) > 0 ||
          (expect.set_cookie_absent?.length ?? 0) > 0 ||
          expect.location !== undefined;
        if (!asserts) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['expect'],
            message:
              "strategy 'explicit_expectations' must assert at least one of expect.status, expect.body.json_paths, expect.headers, expect.header_absent, expect.header_present, expect.set_cookie, expect.set_cookie_absent, expect.location",
          });
        }
        if (jsonPaths) {
          for (const key of Object.keys(jsonPaths)) {
            addJsonPathIssue(ctx, ['expect', 'body', 'json_paths', key], key);
          }
        }
      }
    }
    // The converse of the rule above: `compare()` reads `expect` only in the
    // explicit_expectations branch, so an expect block beside any other strategy
    // is silently ignored — the run compares something else entirely and a pass
    // looks like the author's expectations held. Reject at load (fail closed).
    // `custom` is no exception: a comparator hook owns its own assertions and
    // never sees `expect`, so pairing the two is the same mispairing.
    if (compare.expect !== undefined && compare.strategy !== 'explicit_expectations') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expect'],
        message: `compare.expect is only read by strategy 'explicit_expectations' — strategy '${compare.strategy}' ignores it; switch compare.strategy to 'explicit_expectations' or remove compare.expect`,
      });
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
  // The two dimensions are behavioral rules like any other (spec Section 8.6).
  if (step.compare?.set_cookie !== undefined || step.compare?.location !== undefined) {
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
