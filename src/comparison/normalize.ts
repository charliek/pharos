import { isPlainObject, parseJsonPath, removeAtPath, transformAtPath } from './jsonpath';
import { REDACTED } from './redaction';
import type { JsonNormalization, TimestampPrecision } from './rules';

/**
 * Normalization (spec Section 8.2). Deterministic transforms applied to a parsed
 * body before comparison so incidental differences disappear and only meaningful
 * ones remain. Runs on a deep clone, so the caller's value is never mutated.
 */

/**
 * Canonical JSON string with object keys sorted recursively. Two logically equal
 * values always produce the same string, so this doubles as the equality and
 * (later) hashing primitive, and guarantees key order never causes a mismatch.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

/** Deep structural equality, independent of object key order. */
export function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

const UNIT_MS: Record<TimestampPrecision, number> = {
  milliseconds: 1,
  seconds: 1_000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/**
 * Parse a timestamp, convert to UTC, and truncate to the configured precision,
 * re-emitting a canonical UTC ISO-8601 string. Two values for the same instant
 * normalize equal even across zone formats; values at genuinely different
 * instants stay different, so this can never mask a real time bug. Unparseable
 * values are left untouched. A numeric value is treated as an epoch in
 * milliseconds (the JS convention); reconciling differing numeric epoch units
 * across services is a custom-normalizer concern, not this rule's.
 */
export function normalizeTimestamp(value: unknown, precision: TimestampPrecision): unknown {
  if (typeof value !== 'string' && typeof value !== 'number') return value;
  const date = new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return value;
  const truncated = Math.floor(ms / UNIT_MS[precision]) * UNIT_MS[precision];
  return new Date(truncated).toISOString();
}

/** Map an enum value through its alias table to a single canonical token. */
export function mapEnumAlias(value: unknown, aliases: Record<string, string>): unknown {
  return typeof value === 'string' && value in aliases ? aliases[value] : value;
}

/** Compare two pre-computed canonical strings. */
function compareCanonical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sort an array by a stable element key, tie-broken on the full element. Each
 * element's sort key and canonical form are computed once (decorate-sort), not
 * repeatedly inside the comparator.
 */
export function sortArrayByKey(value: unknown, key: string): unknown {
  if (!Array.isArray(value)) return value;
  const decorated = value.map((item) => ({
    item,
    sortKey: stableStringify(isPlainObject(item) ? item[key] : undefined),
    full: stableStringify(item),
  }));
  decorated.sort(
    (a, b) => compareCanonical(a.sortKey, b.sortKey) || compareCanonical(a.full, b.full),
  );
  return decorated.map((entry) => entry.item);
}

/** Order an array as a set: sort by each element's canonical form (computed once). */
export function sortArrayAsSet(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const decorated = value.map((item) => ({ item, key: stableStringify(item) }));
  decorated.sort((a, b) => compareCanonical(a.key, b.key));
  return decorated.map((entry) => entry.item);
}

/**
 * Apply the contract's JSON normalization rules, in the spec-defined order:
 * remove ignored paths, mask redacted paths, sort arrays by key, order unordered
 * arrays as sets, normalize timestamps, map enum aliases.
 */
export function normalizeJson(value: unknown, rules: JsonNormalization): unknown {
  const clone = structuredClone(value);

  for (const path of rules.ignore_paths) {
    removeAtPath(clone, parseJsonPath(path));
  }
  for (const path of rules.redact_paths) {
    transformAtPath(clone, parseJsonPath(path), () => REDACTED);
  }
  for (const rule of rules.sort_arrays) {
    transformAtPath(clone, parseJsonPath(rule.path), (array) => sortArrayByKey(array, rule.key));
  }
  for (const rule of rules.unordered_arrays) {
    transformAtPath(clone, parseJsonPath(rule.path), (array) => sortArrayAsSet(array));
  }
  for (const rule of rules.normalize_timestamps) {
    transformAtPath(clone, parseJsonPath(rule.path), (ts) =>
      normalizeTimestamp(ts, rule.precision),
    );
  }
  for (const rule of rules.enum_aliases) {
    transformAtPath(clone, parseJsonPath(rule.path), (val) => mapEnumAlias(val, rule.aliases));
  }
  return clone;
}
