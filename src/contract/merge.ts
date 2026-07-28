import { stableStringify } from '../comparison/normalize';
import {
  type ComparisonBlock,
  type ComparisonRules,
  defaultComparisonRules,
  defaultLocationRules,
  defaultSetCookieRules,
  emptyJsonNormalization,
  type JsonNormalization,
  type JsonNormalizationInput,
  type LocationBlock,
  type LocationRules,
  type SetCookieBlock,
  type SetCookieRules,
} from '../comparison/rules';
import type { ScenarioCompare } from '../scenarios/schema';
import type { Contract, ContractRoute } from './model';

/**
 * Merge contract behavioral rules into the engine-facing {@link ComparisonRules}.
 * The convention (shared with Limen, spec Section 5.4) is: **scalar fields
 * override, list fields concatenate defaults-then-route and then de-duplicate,
 * preserving the first occurrence**. Because the behavioral and operational
 * vocabularies occupy disjoint namespaces, the merge is a union, never a
 * reconciliation.
 */

/**
 * Concatenate two lists and drop later duplicates. Entries are compared by their
 * canonical form, so structured rules (`{path, key}`) de-duplicate by whole
 * value independent of key order — the same identity Limen's `concat_dedup`
 * uses, which is what keeps a shared contract resolving identically in both.
 */
function concatDedup<T>(base: readonly T[], extra: readonly T[] | undefined): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const entry of extra ? [...base, ...extra] : base) {
    const key = stableStringify(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function mergeJsonNormalization(
  base: JsonNormalization,
  override: JsonNormalizationInput | undefined,
): JsonNormalization {
  if (!override) return base;
  return {
    ignore_paths: concatDedup(base.ignore_paths, override.ignore_paths),
    redact_paths: concatDedup(base.redact_paths, override.redact_paths),
    sort_arrays: concatDedup(base.sort_arrays, override.sort_arrays),
    unordered_arrays: concatDedup(base.unordered_arrays, override.unordered_arrays),
    normalize_timestamps: concatDedup(base.normalize_timestamps, override.normalize_timestamps),
    enum_aliases: concatDedup(base.enum_aliases, override.enum_aliases),
  };
}

/**
 * Field-wise merge of a `set_cookie` block. Absent in **both** layers leaves the
 * dimension absent (not compared at all); present in either resolves every
 * omitted field to its normative default (spec Section 8.6).
 */
function mergeSetCookie(
  base: SetCookieRules | undefined,
  override: SetCookieBlock | undefined,
): SetCookieRules | undefined {
  if (!base && !override) return undefined;
  const current = base ?? defaultSetCookieRules();
  if (!override) return current;
  return {
    compare: override.compare ?? current.compare,
    ignore_cookies: concatDedup(current.ignore_cookies, override.ignore_cookies),
    ignore_attributes: concatDedup(current.ignore_attributes, override.ignore_attributes),
    compare_values: override.compare_values ?? current.compare_values,
  };
}

/** Field-wise merge of a `location` block; same absent-in-both rule as `set_cookie`. */
function mergeLocation(
  base: LocationRules | undefined,
  override: LocationBlock | undefined,
): LocationRules | undefined {
  if (!base && !override) return undefined;
  const current = base ?? defaultLocationRules();
  if (!override) return current;
  return {
    compare: override.compare ?? current.compare,
    ignore_query_params: concatDedup(current.ignore_query_params, override.ignore_query_params),
    origin: override.origin ?? current.origin,
  };
}

function applyBlock(rules: ComparisonRules, block: ComparisonBlock | undefined): ComparisonRules {
  if (!block) return rules;
  const merged: ComparisonRules = {
    compare_status: block.compare_status ?? rules.compare_status,
    compare_body: block.compare_body ?? rules.compare_body,
    compare_headers: concatDedup(rules.compare_headers, block.compare_headers),
    json: mergeJsonNormalization(rules.json, block.json),
  };
  const setCookie = mergeSetCookie(rules.set_cookie, block.set_cookie);
  if (setCookie) merged.set_cookie = setCookie;
  const location = mergeLocation(rules.location, block.location);
  if (location) merged.location = location;
  return merged;
}

/**
 * Resolve service `defaults` and a per-route `comparison` block onto the base
 * posture. The single resolution entry point — contract routes and the
 * cross-engine decision table both go through it.
 */
export function resolveComparisonRules(
  defaults: ComparisonBlock | undefined,
  override: ComparisonBlock | undefined,
): ComparisonRules {
  return applyBlock(applyBlock(defaultComparisonRules(), defaults), override);
}

/** Merge service `defaults` then the per-route `comparison` block onto the base posture. */
export function mergeContractRoute(contract: Contract, route: ContractRoute): ComparisonRules {
  return resolveComparisonRules(contract.defaults, route.comparison);
}

/**
 * Build comparison rules from a scenario step's inline `compare` block (the
 * no-contract fallback, spec Section 4.7), using the same vocabulary as the
 * contract. Only valid when the scenario does not reference a contract — the
 * schema enforces the mutual exclusion.
 */
export function inlineComparisonRules(compare: ScenarioCompare | undefined): ComparisonRules {
  const rules = defaultComparisonRules();
  if (!compare) return rules;

  if (compare.headers?.compare?.length) {
    rules.compare_headers = concatDedup(compare.headers.compare, undefined);
  }
  if (compare.body) {
    // Reuse the contract merge: the inline body uses the same vocabulary, so
    // merging it onto an empty base yields the normalization rules.
    rules.json = mergeJsonNormalization(emptyJsonNormalization(), compare.body);
  }
  // The two dimensions use the contract's blocks verbatim (spec Section 8.6), so
  // an inline scenario resolves them exactly as a contract route would.
  const setCookie = mergeSetCookie(undefined, compare.set_cookie);
  if (setCookie) rules.set_cookie = setCookie;
  const location = mergeLocation(undefined, compare.location);
  if (location) rules.location = location;
  return rules;
}
