import { describe, expect, it } from 'vitest';
import { type FieldIssue, ValidationError } from '../src/errors';
import { loadScenarioFromText } from '../src/scenarios/load';

function issuesOf(yaml: string): FieldIssue[] {
  try {
    loadScenarioFromText(yaml, 'scenario.yaml');
    return [];
  } catch (error) {
    if (error instanceof ValidationError) return error.issues;
    throw error;
  }
}

function paths(yaml: string): string[] {
  return issuesOf(yaml).map((issue) => issue.path);
}

const VALID = `
version: 1
id: users.get-user
name: Get user
service: user-service
tags: [read, smoke]
mode: compare_live
steps:
  - id: get
    request:
      method: GET
      path: /users/1
    compare:
      strategy: json_semantic
      status: same
`;

describe('scenario schema — acceptance', () => {
  it('accepts a valid minimal scenario', () => {
    expect(() => loadScenarioFromText(VALID, 'scenario.yaml')).not.toThrow();
  });

  it('accepts new_only_assert with explicit_expectations', () => {
    const yaml = `
version: 1
id: users.health
name: Health
service: user-service
tags: [smoke]
mode: new_only_assert
steps:
  - id: health
    request: { method: GET, path: /health }
    compare:
      strategy: explicit_expectations
      expect:
        status: 200
        body:
          json_paths:
            $.status: ok
`;
    expect(() => loadScenarioFromText(yaml, 's.yaml')).not.toThrow();
  });

  it('allows a contract reference alongside subset require_matching_paths', () => {
    const yaml = `
version: 1
id: users.subset
name: Subset
service: user-service
tags: [read]
mode: compare_live
contract: "../contracts/user-service.contract.yaml#get-user"
steps:
  - id: get
    request: { method: GET, path: /users/1 }
    compare:
      strategy: subset
      body:
        require_matching_paths: ["$.id", "$.name"]
`;
    expect(() => loadScenarioFromText(yaml, 's.yaml')).not.toThrow();
  });
});

describe('scenario schema — validation matrix', () => {
  it('rejects a missing id', () => {
    expect(paths(VALID.replace(/^id:.*$/m, ''))).toContain('id');
  });

  it('rejects an unknown mode', () => {
    expect(paths(VALID.replace('mode: compare_live', 'mode: teleport'))).toContain('mode');
  });

  it('rejects a missing request method', () => {
    const yaml = VALID.replace('      method: GET\n', '');
    expect(paths(yaml)).toContain('steps[0].request.method');
  });

  it('rejects an unknown comparison strategy', () => {
    const yaml = VALID.replace('strategy: json_semantic', 'strategy: telepathy');
    expect(paths(yaml)).toContain('steps[0].compare.strategy');
  });

  it('rejects an unknown top-level key (strict schema)', () => {
    expect(issuesOf(`${VALID}\nbogusKey: true\n`).length).toBeGreaterThan(0);
  });

  it('rejects a non-conforming id', () => {
    expect(paths(VALID.replace('users.get-user', 'Users.GetUser')).length).toBeGreaterThan(0);
  });

  it('rejects an empty tags list', () => {
    expect(paths(VALID.replace('tags: [read, smoke]', 'tags: []'))).toContain('tags');
  });

  it('requires a compare block on a compare_live step', () => {
    const yaml = `
version: 1
id: users.no-compare
name: No compare
service: user-service
tags: [read]
mode: compare_live
steps:
  - id: get
    request: { method: GET, path: /users/1 }
`;
    expect(paths(yaml)).toContain('steps[0].compare');
  });

  it("requires require_matching_paths for the 'subset' strategy", () => {
    const yaml = VALID.replace('strategy: json_semantic\n      status: same', 'strategy: subset');
    expect(paths(yaml)).toContain('steps[0].compare.body.require_matching_paths');
  });

  it("rejects json_semantic in 'new_only_assert' mode", () => {
    const yaml = `
version: 1
id: users.new-only
name: New only
service: user-service
tags: [read]
mode: new_only_assert
steps:
  - id: get
    request: { method: GET, path: /users/1 }
    compare:
      strategy: json_semantic
`;
    expect(paths(yaml)).toContain('steps[0].compare');
  });

  it('rejects duplicate step ids', () => {
    const yaml = `
version: 1
id: users.dupe
name: Dupe
service: user-service
tags: [read]
mode: compare_live
steps:
  - id: get
    request: { method: GET, path: /users/1 }
    compare: { strategy: json_semantic }
  - id: get
    request: { method: GET, path: /users/2 }
    compare: { strategy: json_semantic }
`;
    expect(paths(yaml)).toContain('steps[1].id');
  });

  it("requires safety.destructive on a 'destructive'-tagged scenario", () => {
    const yaml = VALID.replace('tags: [read, smoke]', 'tags: [read, destructive]');
    expect(paths(yaml)).toContain('safety.destructive');
  });

  it('accepts a destructive scenario that declares its safety posture', () => {
    const yaml = VALID.replace(
      'tags: [read, smoke]',
      'tags: [read, destructive]\nsafety:\n  destructive: true',
    );
    expect(() => loadScenarioFromText(yaml, 's.yaml')).not.toThrow();
  });

  it('rejects a contract reference combined with inline behavioral rules', () => {
    const yaml = `
version: 1
id: users.conflict
name: Conflict
service: user-service
tags: [read]
mode: compare_live
contract: "../contracts/user-service.contract.yaml#get-user"
steps:
  - id: get
    request: { method: GET, path: /users/1 }
    compare:
      strategy: json_semantic
      body:
        ignore_paths: ["$.metadata.requestId"]
`;
    expect(paths(yaml)).toContain('steps[0].compare');
  });

  it('rejects an out-of-subset JSONPath in inline rules', () => {
    const yaml = `
version: 1
id: users.badpath
name: Bad path
service: user-service
tags: [read]
mode: compare_live
steps:
  - id: get
    request: { method: GET, path: /users/1 }
    compare:
      strategy: json_semantic
      body:
        ignore_paths: ["$.items[0].id"]
`;
    expect(issuesOf(yaml).some((i) => /supported subset/.test(i.message))).toBe(true);
  });

  it('rejects HEAD as a request method (requests are GET/POST/PUT/PATCH/DELETE)', () => {
    expect(paths(VALID.replace('method: GET', 'method: HEAD'))).toContain(
      'steps[0].request.method',
    );
  });

  it('rejects an explicit_expectations block that asserts nothing', () => {
    const yaml = `
version: 1
id: users.empty-expect
name: Empty expect
service: user-service
tags: [smoke]
mode: new_only_assert
steps:
  - id: get
    request: { method: GET, path: /x }
    compare:
      strategy: explicit_expectations
      expect: {}
`;
    expect(paths(yaml)).toContain('steps[0].compare.expect');
  });

  it('reports the file and line on a YAML parse error', () => {
    try {
      loadScenarioFromText('id: [unterminated', 'broken.yaml');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).file).toBe('broken.yaml');
    }
  });
});
