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

/** VALID with the step's request block rewritten (one `field: value` per line). */
function withRequest(...lines: string[]): string {
  return VALID.replace(
    '      method: GET\n      path: /users/1\n',
    lines.map((line) => `      ${line}\n`).join(''),
  );
}

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

  it('accepts the cookie-jar opt-in and leaves it absent by default', () => {
    expect(loadScenarioFromText(VALID, 'scenario.yaml').cookies).toBeUndefined();
    expect(loadScenarioFromText(`${VALID}cookies: true\n`, 'scenario.yaml').cookies).toBe(true);
  });

  it('rejects a non-boolean cookies field', () => {
    expect(paths(`${VALID}cookies: yes-please\n`)).toContain('cookies');
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

  it('rejects TRACE as a request method (spec Section 9.1 lists the seven)', () => {
    expect(paths(VALID.replace('method: GET', 'method: TRACE'))).toContain(
      'steps[0].request.method',
    );
  });

  it.each(['OPTIONS', 'HEAD'])('accepts %s as a request method', (method) => {
    expect(paths(VALID.replace('method: GET', `method: ${method}`))).toEqual([]);
  });

  it.each([
    ['body', 'body: { a: 1 }'],
    ['form', 'form: { a: "1" }'],
  ])('rejects %s on an OPTIONS request (bodies are unreliable there)', (field, line) => {
    const yaml = withRequest('method: OPTIONS', 'path: /users', line);
    expect(paths(yaml)).toContain(`steps[0].request.${field}`);
  });

  it('rejects a request that sets both body and form', () => {
    const yaml = withRequest(
      'method: POST',
      'path: /token',
      'body: { a: 1 }',
      'form: { grant_type: authorization_code }',
    );
    expect(paths(yaml)).toContain('steps[0].request.form');
  });

  it('rejects a form body on a GET request (a GET form has no meaning)', () => {
    const yaml = withRequest('method: GET', 'path: /users', 'form: { a: "1" }');
    expect(paths(yaml)).toContain('steps[0].request.form');
  });

  it('accepts follow_redirects and a form body', () => {
    const yaml = withRequest(
      'method: POST',
      'path: /oauth2/token',
      'follow_redirects: false',
      'form: { grant_type: authorization_code, expires_in: 300, offline: true }',
    );
    expect(paths(yaml)).toEqual([]);
  });

  // Cookie extraction differs from the two sources above only in its `from`.
  const cookieExtract = (from: string) => `
version: 1
id: auth.refresh-cookie
name: Refresh cookie
service: user-service
tags: [read]
mode: new_only_assert
steps:
  - id: login
    request: { method: POST, path: /login }
    extract:
      refreshToken:
        from: ${from}
        path: refresh_token
    compare:
      strategy: explicit_expectations
      expect:
        status: 200
`;

  it('accepts a set_cookie extract source with a cookie name (not a JSONPath)', () => {
    expect(paths(cookieExtract('response.set_cookie'))).toEqual([]);
  });

  it('rejects legacy.set_cookie in new_only_assert (there is no legacy response)', () => {
    expect(paths(cookieExtract('legacy.set_cookie'))).toContain(
      'steps[0].extract.refreshToken.from',
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

describe('inline set_cookie / location blocks (spec §8.6)', () => {
  /** VALID with the step's compare block replaced by the given YAML lines. */
  function withCompare(...lines: string[]): string {
    return VALID.replace(
      '      strategy: json_semantic\n      status: same\n',
      `      strategy: json_semantic\n${lines.map((line) => `      ${line}\n`).join('')}`,
    );
  }

  it('accepts the dimensions inline when no contract is referenced', () => {
    expect(
      paths(
        withCompare(
          'set_cookie: { ignore_attributes: [Expires] }',
          'location: { ignore_query_params: [state], origin: ignore }',
        ),
      ),
    ).toEqual([]);
  });

  it('rejects compare_headers naming a dimension whose block is present', () => {
    expect(paths(withCompare('headers: { compare: [Set-Cookie] }', 'set_cookie: {}'))).toEqual([
      'steps[0].compare.headers.compare',
    ]);
    expect(paths(withCompare('headers: { compare: [location] }', 'location: {}'))).toEqual([
      'steps[0].compare.headers.compare',
    ]);
  });

  it('counts a dimension block as inline behavioral rules (contract exclusion)', () => {
    const withContract = withCompare('set_cookie: {}').replace(
      'mode: compare_live\n',
      'mode: compare_live\ncontract: "../contracts/user-service.contract.yaml#get-user"\n',
    );
    expect(paths(withContract)).toEqual(['steps[0].compare']);
  });

  it('rejects an unknown field inside a dimension block', () => {
    expect(paths(withCompare('location: { origin: sideways }'))).toEqual([
      'steps[0].compare.location.origin',
    ]);
  });
});
