import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compare } from '../src/comparison/compare';
import { locateUrl, parseSetCookie } from '../src/comparison/headers';
import { SENSITIVE_QUERY_PARAMS } from '../src/comparison/redaction';
import { neutralMismatchKinds } from '../src/comparison/result';
import { type ComparisonRules, comparisonBlockSchema } from '../src/comparison/rules';
import { loadContractFile } from '../src/contract/load';
import { mergeContractRoute, resolveComparisonRules } from '../src/contract/merge';
import type { HttpResponseRecord } from '../src/execution/http-client';

/**
 * Cross-repo contract conformance: replay the lockstep decision table through
 * Pharos's real loader, merge, and comparison code.
 *
 * `tests/fixtures/lockstep/lockstep.contract.yaml` and `decisions.json` are
 * byte-identical twins of Limen's copies (`limen/tests/lockstep/`). Limen runs
 * the same table through its own engine, so any divergence in the shared
 * vocabulary — parsing, merge, or comparison — fails in one repo or the other.
 */

const LOCKSTEP_DIR = join(__dirname, 'fixtures/lockstep');

interface MergeCase {
  id: string;
  route_id: string;
  expected_rules: Record<string, unknown>;
}

/** A header in the table: one value, or several for a repeated header (`set-cookie`). */
type HeaderField = string | string[];

interface Side {
  status: number;
  /** The URL of the request that produced this response; a relative Location resolves against it. */
  request_url?: string;
  headers?: Record<string, HeaderField>;
  /** Absent means "empty on both sides", so the body dimension never decides a verdict case. */
  body?: string;
}

interface VerdictCase {
  id: string;
  rules: unknown;
  legacy: Side;
  new: Side;
  expected: { is_match: boolean; mismatch_kinds: string[] };
}

interface DecisionTable {
  merge_cases: MergeCase[];
  verdict_cases: VerdictCase[];
}

const decisions = JSON.parse(
  readFileSync(join(LOCKSTEP_DIR, 'decisions.json'), 'utf8'),
) as DecisionTable;

/**
 * Render resolved rules as the engine-neutral JSON shape `decisions.json` uses.
 * Two canonicalizations, both of which are exactly what the table is asserting:
 * a dimension no layer declared is `null` rather than absent, and the timestamp
 * precision Limen historically spells `millis` is recorded canonically as
 * `milliseconds` (both spellings must resolve to the same precision).
 */
function rulesAsFacts(rules: ComparisonRules): Record<string, unknown> {
  return {
    compare_status: rules.compare_status,
    compare_body: rules.compare_body,
    compare_headers: rules.compare_headers,
    json: {
      ...rules.json,
      normalize_timestamps: rules.json.normalize_timestamps.map((rule) => ({
        ...rule,
        precision: rule.precision === 'millis' ? 'milliseconds' : rule.precision,
      })),
    },
    set_cookie: rules.set_cookie ?? null,
    location: rules.location ?? null,
  };
}

/** A side's values for one header (lowercase name), one-or-many normalized to a list. */
function headerValues(side: Side, name: string): string[] {
  for (const [key, field] of Object.entries(side.headers ?? {})) {
    if (key.toLowerCase() !== name) continue;
    return Array.isArray(field) ? field : [field];
  }
  return [];
}

/** Build a captured response from the table's engine-neutral response shape. */
function toResponse(side: Side): HttpResponseRecord {
  const headers: Record<string, string> = {};
  for (const name of Object.keys(side.headers ?? {})) {
    if (name.toLowerCase() === 'set-cookie') continue;
    // The single-value map keeps the last value, exactly as the Headers API does.
    const values = headerValues(side, name.toLowerCase());
    headers[name.toLowerCase()] = values[values.length - 1];
  }
  return {
    status: side.status,
    headers,
    setCookie: headerValues(side, 'set-cookie'),
    bodyText: side.body ?? '',
    durationMs: 0,
  };
}

/**
 * The cookie values a side sets, used to prove none is ever rendered. Short
 * values (`us`, `one`) occur as substrings of the result's own field names, so
 * only distinctive ones are checked here; the exhaustive proof is the dedicated
 * redaction test in `comparison-headers.test.ts`.
 */
function cookieValues(side: Side): string[] {
  return headerValues(side, 'set-cookie')
    .map((raw) => parseSetCookie(raw)?.value ?? '')
    .filter((value) => value.length >= 5);
}

/**
 * The values a side's `Location` carries under a secret-bearing query parameter
 * name (an OAuth `code`, an `access_token`), which the rendered result must mask
 * just as it masks cookie values.
 */
function sensitiveQueryValues(side: Side): string[] {
  const out: string[] = [];
  for (const raw of headerValues(side, 'location')) {
    const { url } = locateUrl({ location: raw }, side.request_url);
    if (!url) continue;
    for (const [name, value] of url.searchParams) {
      if (SENSITIVE_QUERY_PARAMS.includes(name.toLowerCase()) && value.length >= 5) out.push(value);
    }
  }
  return out;
}

describe('lockstep: the shared contract fixture', () => {
  it('loads and validates clean through the real contract loader', () => {
    const contract = loadContractFile(join(LOCKSTEP_DIR, 'lockstep.contract.yaml'));
    expect(contract.service).toBe('example-service');
    expect(contract.routes.length).toBeGreaterThan(0);
  });
});

describe('lockstep: the decision table matches the merge engine', () => {
  const contract = loadContractFile(join(LOCKSTEP_DIR, 'lockstep.contract.yaml'));

  it('has a non-empty merge table', () => {
    expect(decisions.merge_cases.length).toBeGreaterThan(0);
  });

  for (const mergeCase of decisions.merge_cases) {
    it(`resolves ${mergeCase.id}`, () => {
      const route = contract.routes.find((candidate) => candidate.id === mergeCase.route_id);
      expect(route, `contract has no route '${mergeCase.route_id}'`).toBeDefined();
      if (!route) return;
      expect(rulesAsFacts(mergeContractRoute(contract, route))).toEqual(mergeCase.expected_rules);
    });
  }

  it('pins every route in the fixture', () => {
    // A route with no merge case could drift unnoticed between the two engines.
    for (const route of contract.routes) {
      expect(
        decisions.merge_cases.some((mergeCase) => mergeCase.route_id === route.id),
        `route '${route.id}' has no merge case in decisions.json`,
      ).toBe(true);
    }
  });
});

describe('lockstep: the verdict table matches the comparison engine', () => {
  it('has a non-empty verdict table', () => {
    expect(decisions.verdict_cases.length).toBeGreaterThan(0);
  });

  for (const verdictCase of decisions.verdict_cases) {
    it(`decides ${verdictCase.id}`, () => {
      // Verdict cases carry their rules inline, so they resolve over empty
      // service defaults — through the same schema and merge a contract uses.
      const block = comparisonBlockSchema.parse(verdictCase.rules);
      const rules = resolveComparisonRules(undefined, block);
      const result = compare({
        strategy: 'json_semantic',
        rules,
        legacy: toResponse(verdictCase.legacy),
        candidate: toResponse(verdictCase.new),
        legacyRequestUrl: verdictCase.legacy.request_url,
        candidateRequestUrl: verdictCase.new.request_url,
      });

      expect(result.pass, JSON.stringify(result.mismatches)).toBe(verdictCase.expected.is_match);
      expect(neutralMismatchKinds(result.mismatches)).toEqual(verdictCase.expected.mismatch_kinds);

      // No cookie value, and no secret-bearing Location query value, may reach
      // an output surface (Pharos invariant 2).
      const rendered = JSON.stringify(result);
      for (const secret of [
        ...cookieValues(verdictCase.legacy),
        ...cookieValues(verdictCase.new),
        ...sensitiveQueryValues(verdictCase.legacy),
        ...sensitiveQueryValues(verdictCase.new),
      ]) {
        expect(rendered, `rendered result leaked '${secret}'`).not.toContain(secret);
      }
    });
  }
});
