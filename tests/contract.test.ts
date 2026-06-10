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
