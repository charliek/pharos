/** Comparison result model (spec Section 8.3). */

export type ComparisonStrategy =
  | 'exact'
  | 'json_semantic'
  | 'subset'
  | 'explicit_expectations'
  | 'custom';

export type MismatchKind =
  | 'status'
  | 'header'
  | 'body'
  | 'missing'
  | 'extra'
  | 'type'
  | 'value'
  | 'custom';

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
}
