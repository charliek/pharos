/** Comparison result model (spec Section 8.3). */

export type ComparisonStrategy =
  | 'exact'
  | 'json_semantic'
  | 'subset'
  | 'explicit_expectations'
  | 'custom';

/**
 * The kinds of difference a comparison reports. The `set_cookie.*` /
 * `location.*` members (spec Section 8.6) are the **shared, engine-neutral**
 * vocabulary the cross-engine decision table records, so they must stay
 * identical to Limen's — see {@link neutralMismatchKinds}.
 */
export type MismatchKind =
  | 'status'
  | 'header'
  | 'body'
  | 'missing'
  | 'extra'
  | 'type'
  | 'value'
  | 'custom'
  | 'set_cookie.presence'
  | 'set_cookie.value'
  | 'set_cookie.attribute'
  | 'set_cookie.malformed'
  | 'location.presence'
  | 'location.origin'
  | 'location.path'
  | 'location.query'
  | 'location.raw';

export interface Mismatch {
  /** Where the difference is, as a JSONPath-style address ($ for the whole body). */
  path: string;
  kind: MismatchKind;
  expected?: unknown;
  actual?: unknown;
  message: string;
}

export interface ComparisonResult {
  pass: boolean;
  summary: string;
  mismatches: Mismatch[];
  /** Human-readable rendering of the mismatches, suitable for console/artifacts. */
  diffText?: string;
  /**
   * True when a bounded mismatch list was clipped at `MAX_DIFFERENCES`
   * (spec Section 8.6) — the result is a sample, not the whole story.
   */
  diffTruncated?: boolean;
}

/** The body-level kinds the neutral vocabulary collapses into a single `body`. */
const BODY_KINDS = new Set<MismatchKind>(['body', 'missing', 'extra', 'type', 'value']);

/**
 * The engine-neutral kinds of mismatch a result carries, sorted and
 * de-duplicated: `status`, `body`, `header`, `set_cookie.<kind>`,
 * `location.<kind>`.
 *
 * This is the vocabulary the cross-engine verdict table
 * (`tests/fixtures/lockstep/decisions.json`) records, so it must stay identical
 * to Limen's `ComparisonResult::mismatch_kinds`. It is a *set*, deliberately
 * order-independent: the two engines need not agree on the order in which they
 * discover mismatches, only on which kinds exist.
 */
export function neutralMismatchKinds(mismatches: readonly Mismatch[]): string[] {
  const kinds = new Set<string>();
  for (const mismatch of mismatches) {
    kinds.add(BODY_KINDS.has(mismatch.kind) ? 'body' : mismatch.kind);
  }
  return [...kinds].sort();
}
