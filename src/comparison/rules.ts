import { z } from 'zod';
import { JsonPathError, parseJsonPath } from './jsonpath';
import { asciiLower } from './redaction';

/**
 * The normalization vocabulary shared by the behavioral contract and the inline
 * scenario fallback (spec Sections 5.2 and 4.7). Field names are snake_case
 * because this is the portable on-disk vocabulary shared with Limen — keeping
 * the parsed shapes identical to the YAML avoids a translation layer that could
 * drift between the two tools.
 */

/** A `zod` string that must be within the supported JSONPath subset. */
export const jsonPathSchema = z.string().superRefine((value, ctx) => {
  try {
    parseJsonPath(value);
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof JsonPathError ? error.message : `invalid JSONPath '${value}'`,
    });
  }
});

/**
 * Timestamp precisions. `millis` is Limen's historical spelling of
 * `milliseconds`; **both** tools accept **both** spellings so one contract file
 * parses on either side (spec Sections 8.2 and 13). `milliseconds` is the
 * canonical spelling documentation and tooling emit.
 */
export const TIMESTAMP_PRECISIONS = [
  'milliseconds',
  'millis',
  'seconds',
  'minutes',
  'hours',
  'days',
] as const;
export type TimestampPrecision = (typeof TIMESTAMP_PRECISIONS)[number];
export const timestampPrecisionSchema = z.enum(TIMESTAMP_PRECISIONS);

export const sortArrayRuleSchema = z
  .object({ path: jsonPathSchema, key: z.string().min(1) })
  .strict();
export const unorderedArrayRuleSchema = z.object({ path: jsonPathSchema }).strict();
export const normalizeTimestampRuleSchema = z
  .object({ path: jsonPathSchema, precision: timestampPrecisionSchema })
  .strict();
export const enumAliasRuleSchema = z
  .object({ path: jsonPathSchema, aliases: z.record(z.string()) })
  .strict();

export const jsonNormalizationSchema = z
  .object({
    ignore_paths: z.array(jsonPathSchema).optional(),
    redact_paths: z.array(jsonPathSchema).optional(),
    sort_arrays: z.array(sortArrayRuleSchema).optional(),
    unordered_arrays: z.array(unorderedArrayRuleSchema).optional(),
    normalize_timestamps: z.array(normalizeTimestampRuleSchema).optional(),
    enum_aliases: z.array(enumAliasRuleSchema).optional(),
  })
  .strict();

export const COOKIE_VALUE_MODES = ['exact', 'presence'] as const;
export type CookieValueMode = (typeof COOKIE_VALUE_MODES)[number];
export const ORIGIN_MODES = ['exact', 'ignore'] as const;
export type OriginMode = (typeof ORIGIN_MODES)[number];

/**
 * The `set_cookie` comparison dimension (spec Section 8.6). Every field is
 * optional: a **present but empty** block resolves to
 * `{compare: true, ignore_cookies: [], ignore_attributes: [], compare_values: exact}`,
 * while an **absent** block means the dimension is not compared at all.
 */
export const setCookieBlockSchema = z
  .object({
    compare: z.boolean().optional(),
    ignore_cookies: z.array(z.string()).optional(),
    ignore_attributes: z.array(z.string()).optional(),
    compare_values: z.enum(COOKIE_VALUE_MODES).optional(),
  })
  .strict();

/** The `location` comparison dimension (spec Section 8.6); same present/absent rule. */
export const locationBlockSchema = z
  .object({
    compare: z.boolean().optional(),
    ignore_query_params: z.array(z.string()).optional(),
    origin: z.enum(ORIGIN_MODES).optional(),
  })
  .strict();

/** A `comparison`/`defaults` block as it appears in a contract. */
export const comparisonBlockSchema = z
  .object({
    compare_status: z.boolean().optional(),
    compare_body: z.boolean().optional(),
    compare_headers: z.array(z.string()).optional(),
    json: jsonNormalizationSchema.optional(),
    set_cookie: setCookieBlockSchema.optional(),
    location: locationBlockSchema.optional(),
  })
  .strict();

export type JsonNormalizationInput = z.infer<typeof jsonNormalizationSchema>;
export type SetCookieBlock = z.infer<typeof setCookieBlockSchema>;
export type LocationBlock = z.infer<typeof locationBlockSchema>;
export type ComparisonBlock = z.infer<typeof comparisonBlockSchema>;

// --- Engine-facing, fully-resolved rule types (no optionals) ----------------
// These are what `merge` produces and the comparison engine consumes.

export interface SortArrayRule {
  path: string;
  key: string;
}
export interface UnorderedArrayRule {
  path: string;
}
export interface NormalizeTimestampRule {
  path: string;
  precision: TimestampPrecision;
}
export interface EnumAliasRule {
  path: string;
  aliases: Record<string, string>;
}

export interface JsonNormalization {
  ignore_paths: string[];
  redact_paths: string[];
  sort_arrays: SortArrayRule[];
  unordered_arrays: UnorderedArrayRule[];
  normalize_timestamps: NormalizeTimestampRule[];
  enum_aliases: EnumAliasRule[];
}

/** Fully-resolved `set_cookie` rules; absent from {@link ComparisonRules} = not compared. */
export interface SetCookieRules {
  compare: boolean;
  ignore_cookies: string[];
  ignore_attributes: string[];
  compare_values: CookieValueMode;
}

/** Fully-resolved `location` rules; absent from {@link ComparisonRules} = not compared. */
export interface LocationRules {
  compare: boolean;
  ignore_query_params: string[];
  origin: OriginMode;
}

export interface ComparisonRules {
  compare_status: boolean;
  compare_body: boolean;
  compare_headers: string[];
  json: JsonNormalization;
  /** Present only when some layer declared a `set_cookie` block (spec Section 8.6). */
  set_cookie?: SetCookieRules;
  /** Present only when some layer declared a `location` block (spec Section 8.6). */
  location?: LocationRules;
}

/** The resolved defaults of a present-but-empty `set_cookie` block (normative, lockstep). */
export function defaultSetCookieRules(): SetCookieRules {
  return {
    compare: true,
    ignore_cookies: [],
    ignore_attributes: [],
    compare_values: 'exact',
  };
}

/** The resolved defaults of a present-but-empty `location` block (normative, lockstep). */
export function defaultLocationRules(): LocationRules {
  return { compare: true, ignore_query_params: [], origin: 'exact' };
}

/**
 * Every misuse of `compare_headers` as a stand-in for an optional comparison
 * dimension (spec Section 8.6). `set_cookie` and `location` are dimensions of
 * their own rather than `compare_headers` entries, so a hit is a load-time
 * validation error rather than a warning. The two are deliberately
 * **asymmetric**:
 *
 * - `set-cookie` is an error *unconditionally*, block or no block. The generic
 *   header path compares one value per name (`headersToObject` keeps only the
 *   last `Set-Cookie`), so a response carrying several cookies silently loses
 *   all but one — comparing cookies that way is always a config bug, and the
 *   dedicated `set_cookie` block is the only correct tool. Listing the header
 *   therefore never has a legitimate reading, so block presence is not consulted.
 * - `location` is a genuinely single-value header, so the generic path compares
 *   it faithfully; only listing it *alongside* a `location` block is ambiguous
 *   intent — hence the `present.location` argument. Listing it on its own is legal.
 *
 * Names match case-insensitively after trimming whitespace, exactly as Limen's
 * check does. Returns the offending names as authored.
 */
export function dimensionHeaderConflicts(
  compareHeaders: readonly string[] | undefined,
  present: { location?: boolean },
): string[] {
  const out: string[] = [];
  for (const authored of compareHeaders ?? []) {
    const name = asciiLower(authored.trim());
    if (name === 'set-cookie' || (name === 'location' && present.location)) {
      out.push(authored);
    }
  }
  return out;
}

/** The message a {@link dimensionHeaderConflicts} hit produces. */
export function dimensionHeaderConflictMessage(name: string): string {
  if (asciiLower(name.trim()) === 'set-cookie') {
    // Unconditional, so there may be no block to point at — and the generic
    // header path is lossy whether or not one is declared.
    return `compare_headers lists '${name}' — 'set_cookie' is a comparison dimension of its own (spec Section 8.6), and the generic header path compares a single value, silently dropping the rest of a multi-cookie response; drop the compare_headers entry and use a 'set_cookie' block instead`;
  }
  return `compare_headers lists '${name}' while a 'location' comparison block is present — 'location' is a comparison dimension of its own (spec Section 8.6), so drop the compare_headers entry`;
}

export function emptyJsonNormalization(): JsonNormalization {
  return {
    ignore_paths: [],
    redact_paths: [],
    sort_arrays: [],
    unordered_arrays: [],
    normalize_timestamps: [],
    enum_aliases: [],
  };
}

/** The default posture: compare status and body, no header comparison, no normalization. */
export function defaultComparisonRules(): ComparisonRules {
  return {
    compare_status: true,
    compare_body: true,
    compare_headers: [],
    json: emptyJsonNormalization(),
  };
}
