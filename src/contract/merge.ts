import {
  type ComparisonBlock,
  type ComparisonRules,
  defaultComparisonRules,
  emptyJsonNormalization,
  type JsonNormalization,
  type JsonNormalizationInput,
} from '../comparison/rules';
import type { ScenarioCompare } from '../scenarios/schema';
import type { Contract, ContractRoute } from './model';

/**
 * Merge contract behavioral rules into the engine-facing {@link ComparisonRules}.
 * The convention (shared with Limen) is: **scalar fields override, list fields
 * concatenate**. Because the behavioral and operational vocabularies occupy
 * disjoint namespaces, the merge is a union, never a reconciliation.
 */

function mergeJsonNormalization(
  base: JsonNormalization,
  override: JsonNormalizationInput | undefined,
): JsonNormalization {
  if (!override) return base;
  return {
    ignore_paths: [...base.ignore_paths, ...(override.ignore_paths ?? [])],
    redact_paths: [...base.redact_paths, ...(override.redact_paths ?? [])],
    sort_arrays: [...base.sort_arrays, ...(override.sort_arrays ?? [])],
    unordered_arrays: [...base.unordered_arrays, ...(override.unordered_arrays ?? [])],
    normalize_timestamps: [...base.normalize_timestamps, ...(override.normalize_timestamps ?? [])],
    enum_aliases: [...base.enum_aliases, ...(override.enum_aliases ?? [])],
  };
}

function applyBlock(rules: ComparisonRules, block: ComparisonBlock | undefined): ComparisonRules {
  if (!block) return rules;
  return {
    compare_status: block.compare_status ?? rules.compare_status,
    compare_body: block.compare_body ?? rules.compare_body,
    compare_headers: block.compare_headers
      ? [...rules.compare_headers, ...block.compare_headers]
      : rules.compare_headers,
    json: mergeJsonNormalization(rules.json, block.json),
  };
}

/** Merge service `defaults` then the per-route `comparison` block onto the base posture. */
export function mergeContractRoute(contract: Contract, route: ContractRoute): ComparisonRules {
  let rules = defaultComparisonRules();
  rules = applyBlock(rules, contract.defaults);
  rules = applyBlock(rules, route.comparison);
  return rules;
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
    rules.compare_headers = [...compare.headers.compare];
  }
  if (compare.body) {
    // Reuse the contract merge: the inline body uses the same vocabulary, so
    // merging it onto an empty base yields the normalization rules.
    rules.json = mergeJsonNormalization(emptyJsonNormalization(), compare.body);
  }
  return rules;
}
