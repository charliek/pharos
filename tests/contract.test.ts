import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ContractRegistry,
  loadContractFromText,
  parseContractReference,
} from '../src/contract/load';
import { inlineComparisonRules, mergeContractRoute } from '../src/contract/merge';
import { resolveScenarioContractRules } from '../src/contract/resolve';
import { ValidationError } from '../src/errors';
import { loadScenarioFromText } from '../src/scenarios/load';
import type { ScenarioCompare } from '../src/scenarios/schema';

const here = dirname(fileURLToPath(import.meta.url));
const validContract = resolve(here, 'fixtures/valid/contracts/user-service.contract.yaml');
const validScenario = resolve(here, 'fixtures/valid/scenarios/get-user-success.yaml');

describe('contract schema', () => {
  it('loads a valid contract', () => {
    const contract = loadContractFromText(
      `version: 1
service: s
routes:
  - id: r
    match: { methods: [GET], path_template: /r }
`,
      'c.yaml',
    );
    expect(contract.service).toBe('s');
    expect(contract.routes).toHaveLength(1);
  });

  it('rejects duplicate route ids', () => {
    const yaml = `version: 1
service: s
routes:
  - id: r
    match: { methods: [GET], path_template: /a }
  - id: r
    match: { methods: [GET], path_template: /b }
`;
    try {
      loadContractFromText(yaml, 'c.yaml');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues.map((i) => i.path)).toContain('routes[1].id');
    }
  });

  it('rejects an out-of-subset JSONPath', () => {
    const yaml = `version: 1
service: s
routes:
  - id: r
    match: { methods: [GET], path_template: /r }
    comparison:
      json:
        ignore_paths: ["$.items[0]"]
`;
    expect(() => loadContractFromText(yaml, 'c.yaml')).toThrow(ValidationError);
  });
});

describe('contract reference resolution', () => {
  it('parses path#routeId relative to the referencing file', () => {
    const ref = parseContractReference(
      '../contracts/user-service.contract.yaml#get-user',
      validScenario,
    );
    expect(ref.routeId).toBe('get-user');
    expect(ref.file).toBe(validContract);
  });

  it('rejects a reference without a route fragment', () => {
    expect(() => parseContractReference('foo.yaml', 'x.yaml')).toThrow(ValidationError);
  });

  it('resolves a route through the registry', () => {
    const registry = new ContractRegistry();
    const route = registry.resolveRoute(
      { file: validContract, routeId: 'get-user' },
      validScenario,
    );
    expect(route.id).toBe('get-user');
  });

  it('fails clearly on an unknown route id', () => {
    const registry = new ContractRegistry();
    try {
      registry.resolveRoute({ file: validContract, routeId: 'nope' }, validScenario);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues[0].message).toMatch(/has no route 'nope'/);
    }
  });

  it('fails clearly on a missing contract file', () => {
    const registry = new ContractRegistry();
    try {
      registry.resolveRoute({ file: '/no/such/contract.yaml', routeId: 'x' }, validScenario);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues[0].message).toMatch(/not found/);
    }
  });
});

describe('contract merge', () => {
  it('merges defaults then per-route comparison (lists concatenate)', () => {
    const registry = new ContractRegistry();
    const contract = registry.load(validContract);
    const route = registry.resolveRoute(
      { file: validContract, routeId: 'get-user' },
      validScenario,
    );
    const rules = mergeContractRoute(contract, route);
    expect(rules.compare_status).toBe(true);
    expect(rules.json.ignore_paths).toEqual(['$.metadata.requestId', '$.lastSeenAt']);
    expect(rules.json.redact_paths).toEqual(['$.user.email']);
  });

  it('builds rules from an inline compare block', () => {
    const compare: ScenarioCompare = {
      strategy: 'json_semantic',
      headers: { compare: ['content-type'] },
      body: {
        ignore_paths: ['$.a'],
        sort_arrays: [{ path: '$.items', key: 'id' }],
      },
    };
    const rules = inlineComparisonRules(compare);
    expect(rules.compare_headers).toEqual(['content-type']);
    expect(rules.json.ignore_paths).toEqual(['$.a']);
    expect(rules.json.sort_arrays).toEqual([{ path: '$.items', key: 'id' }]);
  });
});

describe('resolveScenarioContractRules', () => {
  function scenarioWithService(service: string) {
    return loadScenarioFromText(
      `version: 1
id: users.x
name: X
service: ${service}
tags: [read]
mode: compare_live
contract: "../contracts/user-service.contract.yaml#get-user"
steps:
  - id: get
    request: { method: GET, path: /users/1 }
    compare: { strategy: json_semantic, status: same }
`,
      validScenario,
    );
  }

  it('returns merged rules when the scenario service matches the contract', () => {
    const rules = resolveScenarioContractRules(
      scenarioWithService('user-service'),
      validScenario,
      new ContractRegistry(),
    );
    expect(rules.json.ignore_paths).toContain('$.lastSeenAt');
  });

  it('flags a scenario/contract service mismatch (spec §4.3)', () => {
    try {
      resolveScenarioContractRules(
        scenarioWithService('other-service'),
        validScenario,
        new ContractRegistry(),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).issues[0].path).toBe('service');
    }
  });
});

describe('merge: list de-duplication and the new dimensions (spec §5.4, §8.6)', () => {
  const CONTRACT = `version: 1
service: s
defaults:
  compare_headers: ["content-type"]
  json:
    ignore_paths: ["$.a", "$.b"]
    sort_arrays:
      - { path: "$.items", key: id }
  set_cookie:
    ignore_cookies: ["csrf_token"]
routes:
  - id: dedup
    match: { methods: [GET, OPTIONS], path_template: /r }
    comparison:
      compare_headers: ["content-type", "etag"]
      json:
        ignore_paths: ["$.a", "$.c"]
        sort_arrays:
          - { key: id, path: "$.items" }
      set_cookie:
        ignore_cookies: ["csrf_token", "hint"]
        compare_values: presence
  - id: plain
    match: { methods: [GET], path_template: /p }
`;

  function rulesFor(routeId: string) {
    const contract = loadContractFromText(CONTRACT, 'c.yaml');
    const route = contract.routes.find((candidate) => candidate.id === routeId);
    if (!route) throw new Error(`no route ${routeId}`);
    return mergeContractRoute(contract, route);
  }

  it('concatenates then de-duplicates, preserving the first occurrence', () => {
    const rules = rulesFor('dedup');
    expect(rules.compare_headers).toEqual(['content-type', 'etag']);
    expect(rules.json.ignore_paths).toEqual(['$.a', '$.b', '$.c']);
    // Structured entries de-duplicate by whole value, independent of key order.
    expect(rules.json.sort_arrays).toEqual([{ path: '$.items', key: 'id' }]);
    expect(rules.set_cookie?.ignore_cookies).toEqual(['csrf_token', 'hint']);
  });

  it('overrides scalars inside a dimension block while lists still merge', () => {
    expect(rulesFor('dedup').set_cookie).toEqual({
      compare: true,
      ignore_cookies: ['csrf_token', 'hint'],
      ignore_attributes: [],
      compare_values: 'presence',
    });
  });

  it('leaves a dimension absent when no layer declared it, and inherits one that is', () => {
    const rules = rulesFor('plain');
    expect(rules.location).toBeUndefined();
    expect(rules.set_cookie).toEqual({
      compare: true,
      ignore_cookies: ['csrf_token'],
      ignore_attributes: [],
      compare_values: 'exact',
    });
  });

  it('resolves a present-but-empty block to its normative defaults', () => {
    const contract = loadContractFromText(
      `version: 1
service: s
routes:
  - id: r
    match: { methods: [GET], path_template: /r }
    comparison:
      location: {}
`,
      'c.yaml',
    );
    expect(mergeContractRoute(contract, contract.routes[0]).location).toEqual({
      compare: true,
      ignore_query_params: [],
      origin: 'exact',
    });
  });

  it('builds the dimensions from an inline scenario compare block', () => {
    const rules = inlineComparisonRules({
      strategy: 'json_semantic',
      set_cookie: { ignore_attributes: ['Expires'] },
      location: { origin: 'ignore' },
    } as ScenarioCompare);
    expect(rules.set_cookie).toEqual({
      compare: true,
      ignore_cookies: [],
      ignore_attributes: ['Expires'],
      compare_values: 'exact',
    });
    expect(rules.location?.origin).toBe('ignore');
  });
});

describe('compare_headers usurping a dimension (spec §8.6)', () => {
  function issues(yaml: string) {
    try {
      loadContractFromText(yaml, 'c.yaml');
      return [];
    } catch (error) {
      if (error instanceof ValidationError) return error.issues;
      throw error;
    }
  }

  it('rejects a route listing set-cookie while the block is present', () => {
    const found = issues(`version: 1
service: s
routes:
  - id: r
    match: { methods: [GET], path_template: /r }
    comparison:
      compare_headers: ["Set-Cookie "]
      set_cookie: {}
`);
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe('routes[0].comparison.compare_headers');
    expect(found[0].message).toMatch(/set_cookie/);
  });

  it('rejects the conflict across layers, and reports a defaults conflict once', () => {
    const found = issues(`version: 1
service: s
defaults:
  compare_headers: ["location"]
routes:
  - id: a
    match: { methods: [GET], path_template: /a }
    comparison:
      location: { origin: ignore }
  - id: b
    match: { methods: [GET], path_template: /b }
    comparison:
      location: {}
`);
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe('defaults.compare_headers');
  });

  it('rejects a route listing set-cookie with no block anywhere', () => {
    // The generic header path would compare a single value and drop the rest of
    // a multi-cookie response, so the entry is a config bug on its own.
    const found = issues(`version: 1
service: s
routes:
  - id: r
    match: { methods: [GET], path_template: /r }
    comparison:
      compare_headers: ["location", "Set-Cookie"]
`);
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe('routes[0].comparison.compare_headers');
    expect(found[0].message).toMatch(/use a 'set_cookie' block instead/);
  });

  it('rejects set-cookie listed in defaults with no block anywhere', () => {
    const found = issues(`version: 1
service: s
defaults:
  compare_headers: ["set-cookie"]
routes:
  - id: a
    match: { methods: [GET], path_template: /a }
  - id: b
    match: { methods: [GET], path_template: /b }
`);
    expect(found).toHaveLength(1);
    expect(found[0].path).toBe('defaults.compare_headers');
    expect(found[0].message).toMatch(/multi-cookie response/);
  });

  it('allows location when no location block is present', () => {
    // A genuine single-value header: the generic path compares it faithfully.
    expect(
      issues(`version: 1
service: s
defaults:
  compare_headers: ["Location"]
routes:
  - id: r
    match: { methods: [GET], path_template: /r }
`),
    ).toEqual([]);
  });
});
