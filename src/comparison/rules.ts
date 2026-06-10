import { z } from 'zod';
import { JsonPathError, parseJsonPath } from './jsonpath';

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

export const TIMESTAMP_PRECISIONS = [
  'milliseconds',
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

/** A `comparison`/`defaults` block as it appears in a contract. */
export const comparisonBlockSchema = z
  .object({
    compare_status: z.boolean().optional(),
    compare_body: z.boolean().optional(),
    compare_headers: z.array(z.string()).optional(),
    json: jsonNormalizationSchema.optional(),
  })
  .strict();

export type JsonNormalizationInput = z.infer<typeof jsonNormalizationSchema>;
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

export interface ComparisonRules {
  compare_status: boolean;
  compare_body: boolean;
  compare_headers: string[];
  json: JsonNormalization;
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
