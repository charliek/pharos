import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REDACTED } from '../src/comparison/redaction';
import { defaultConfig, type PharosConfig } from '../src/config/config';
import { ContractRegistry } from '../src/contract/load';
import { type Recording, writeRecording } from '../src/execution/fixtures';
import { runScenario } from '../src/execution/runner';
import { loadScenarioFromText } from '../src/scenarios/load';
import { replyJson, startTestServer, type TestServer } from './helpers/server';

let legacyServer: TestServer | undefined;
let newServer: TestServer | undefined;
let reportDir: string;

beforeEach(() => {
  reportDir = mkdtempSync(join(tmpdir(), 'pharos-reports-'));
});

afterEach(async () => {
  await legacyServer?.close();
  await newServer?.close();
  legacyServer = undefined;
  newServer = undefined;
});

function config(overrides: Partial<PharosConfig> = {}): PharosConfig {
  return {
    ...defaultConfig(),
    legacy_base_url: legacyServer?.url,
    new_base_url: newServer?.url,
    report_dir: reportDir,
    fixture_dir: reportDir,
    ...overrides,
  };
}

const registry = new ContractRegistry();

function readArtifacts(scenarioId: string, stepId: string): string {
  const dir = join(reportDir, 'artifacts', scenarioId, stepId);
  return readdirSync(dir)
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n');
}

describe('runScenario — compare_live', () => {
  it('passes when both services agree', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { id: 1, name: 'A' }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { id: 1, name: 'A' }));
    const scenario = loadScenarioFromText(
      `version: 1
id: users.ok
name: ok
service: s
tags: [read]
mode: compare_live
steps:
  - id: get
    request: { method: GET, path: /users/1 }
    compare: { strategy: json_semantic, status: same }
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(true);
    expect(legacyServer.requests).toHaveLength(1);
    expect(newServer.requests).toHaveLength(1);
  });

  it('fails on a divergence and writes redacted artifacts', async () => {
    legacyServer = await startTestServer((_r, res) =>
      replyJson(res, 200, { token: 'SECRET-L', name: 'A' }),
    );
    newServer = await startTestServer((_r, res) =>
      replyJson(res, 200, { token: 'SECRET-N', name: 'B' }),
    );
    const scenario = loadScenarioFromText(
      `version: 1
id: users.diff
name: diff
service: s
tags: [read]
mode: compare_live
steps:
  - id: get
    request: { method: GET, path: /users/1 }
    compare:
      strategy: json_semantic
      status: same
      body:
        redact_paths: ["$.token"]
`,
      'test.yaml',
    );
    const result = await runScenario(
      scenario,
      'test.yaml',
      config({ redaction: { headers: [], json_paths: ['$.token'], query_params: [] } }),
      registry,
    );
    expect(result.pass).toBe(false);
    expect(result.steps[0].comparison?.diffText).toContain('name');
    const artifacts = readArtifacts('users.diff', 'get');
    expect(artifacts).not.toContain('SECRET-L');
    expect(artifacts).not.toContain('SECRET-N');
  });

  it('redacts operator-configured secret paths in the diff and artifacts', async () => {
    legacyServer = await startTestServer((_r, res) =>
      replyJson(res, 200, { token: 'SECRET-L', name: 'A' }),
    );
    newServer = await startTestServer((_r, res) =>
      replyJson(res, 200, { token: 'SECRET-N', name: 'B' }),
    );
    const scenario = loadScenarioFromText(
      `version: 1
id: cfg.redact
name: cfg
service: s
tags: [read]
mode: compare_live
steps:
  - id: get
    request: { method: GET, path: /x }
    compare: { strategy: json_semantic, status: same }
`,
      'test.yaml',
    );
    // No inline redact — only the operator's config.redaction.json_paths.
    const result = await runScenario(
      scenario,
      'test.yaml',
      config({ redaction: { headers: [], json_paths: ['$.token'], query_params: [] } }),
      registry,
    );
    expect(result.pass).toBe(false);
    expect(result.steps[0].comparison?.diffText).toContain('name');
    expect(result.steps[0].comparison?.diffText).not.toContain('SECRET');
    expect(readArtifacts('cfg.redact', 'get')).not.toContain('SECRET');
  });

  it('never writes a raw non-JSON body to an artifact', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { x: 1 }));
    newServer = await startTestServer((_r, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/plain');
      res.end('SECRET-PLAINTEXT-TOKEN');
    });
    const scenario = loadScenarioFromText(
      `version: 1
id: nonjson.diff
name: nonjson
service: s
tags: [read]
mode: compare_live
steps:
  - id: get
    request: { method: GET, path: /x }
    compare: { strategy: json_semantic, status: same }
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(false);
    expect(readArtifacts('nonjson.diff', 'get')).not.toContain('SECRET-PLAINTEXT-TOKEN');
  });

  it('extracts a value and uses it in a later step', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { id: 'abc' }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { id: 'abc' }));
    const scenario = loadScenarioFromText(
      `version: 1
id: users.flow
name: flow
service: s
tags: [read]
mode: compare_live
steps:
  - id: create
    request: { method: GET, path: /create }
    extract:
      newId: { from: new.body, path: $.id }
    compare: { strategy: json_semantic, status: same }
  - id: fetch
    request: { method: GET, path: "/users/{{ variables.newId }}" }
    compare: { strategy: json_semantic, status: same }
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(true);
    expect(newServer.requests[1].url).toBe('/users/abc');
  });

  it('stops at the first failing step', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { v: 'L' }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { v: 'N' }));
    const scenario = loadScenarioFromText(
      `version: 1
id: users.stop
name: stop
service: s
tags: [read]
mode: compare_live
steps:
  - id: one
    request: { method: GET, path: /one }
    compare: { strategy: json_semantic, status: same }
  - id: two
    request: { method: GET, path: /two }
    compare: { strategy: json_semantic, status: same }
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(false);
    expect(result.steps).toHaveLength(1);
  });

  it('reports a missing variable as a step error', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, {}));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, {}));
    const scenario = loadScenarioFromText(
      `version: 1
id: users.badvar
name: badvar
service: s
tags: [read]
mode: compare_live
steps:
  - id: get
    request: { method: GET, path: "/users/{{ variables.nope }}" }
    compare: { strategy: json_semantic, status: same }
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(false);
    expect(result.steps[0].error).toMatch(/nope/);
  });
});

describe('runScenario — hooks', () => {
  it('runs a setup hook that assigns a variable used by a step', async () => {
    let captured = '';
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, {}));
    newServer = await startTestServer((r, res) => {
      captured = r.url;
      replyJson(res, 200, {});
    });
    const scenario = loadScenarioFromText(
      `version: 1
id: hooks.setup
name: setup
service: s
tags: [read]
mode: compare_live
setup:
  hooks:
    - name: genUser
      assign: { userId: id }
steps:
  - id: get
    request: { method: GET, path: "/users/{{ variables.userId }}" }
    compare: { strategy: json_semantic, status: same }
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry, {
      hooks: { genUser: () => ({ id: 'u42' }) },
    });
    expect(result.pass).toBe(true);
    expect(captured).toBe('/users/u42');
  });

  it('runs cleanup after both success and failure', async () => {
    let cleanupRuns = 0;
    const hooks = {
      recordCleanup: () => {
        cleanupRuns += 1;
      },
    };
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { v: 1 }));
    newServer = await startTestServer((r, res) =>
      replyJson(res, 200, { v: r.url === '/fail' ? 2 : 1 }),
    );
    const make = (id: string, path: string) =>
      loadScenarioFromText(
        `version: 1
id: ${id}
name: ${id}
service: s
tags: [read]
mode: compare_live
cleanup:
  hooks: [{ name: recordCleanup }]
steps:
  - id: get
    request: { method: GET, path: ${path} }
    compare: { strategy: json_semantic, status: same }
`,
        'test.yaml',
      );
    const ok = await runScenario(make('c.ok', '/ok'), 'test.yaml', config(), registry, { hooks });
    const fail = await runScenario(make('c.fail', '/fail'), 'test.yaml', config(), registry, {
      hooks,
    });
    expect(ok.pass).toBe(true);
    expect(fail.pass).toBe(false);
    expect(cleanupRuns).toBe(2);
  });

  it('fails clearly on an unknown hook', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, {}));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, {}));
    const scenario = loadScenarioFromText(
      `version: 1
id: hooks.unknown
name: unknown
service: s
tags: [read]
mode: compare_live
setup:
  hooks: [{ name: doesNotExist }]
steps:
  - id: get
    request: { method: GET, path: /x }
    compare: { strategy: json_semantic, status: same }
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry, { hooks: {} });
    expect(result.pass).toBe(false);
    expect(result.error).toMatch(/unknown hook/);
    expect(result.steps).toHaveLength(0);
  });

  it('runs cleanup even when setup throws', async () => {
    let cleanupRan = false;
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, {}));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, {}));
    const scenario = loadScenarioFromText(
      `version: 1
id: hooks.setupfail
name: setupfail
service: s
tags: [read]
mode: compare_live
setup:
  hooks: [{ name: boom }]
cleanup:
  hooks: [{ name: recordCleanup }]
steps:
  - id: get
    request: { method: GET, path: /x }
    compare: { strategy: json_semantic, status: same }
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry, {
      hooks: {
        boom: () => {
          throw new Error('setup boom');
        },
        recordCleanup: () => {
          cleanupRan = true;
        },
      },
    });
    expect(result.pass).toBe(false);
    expect(result.error).toMatch(/setup boom/);
    expect(cleanupRan).toBe(true);
    expect(result.steps).toHaveLength(0);
  });

  it('fails the step when an after hook throws', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { v: 1 }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { v: 1 }));
    const scenario = loadScenarioFromText(
      `version: 1
id: hooks.afterfail
name: afterfail
service: s
tags: [read]
mode: compare_live
steps:
  - id: get
    request: { method: GET, path: /x }
    compare: { strategy: json_semantic, status: same }
    after:
      hooks: [{ name: boomAfter }]
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry, {
      hooks: {
        boomAfter: () => {
          throw new Error('after boom');
        },
      },
    });
    expect(result.pass).toBe(false);
    expect(result.steps[0].error).toMatch(/after boom/);
  });
});

describe('runScenario — legacy_record', () => {
  it('records a redacted legacy interaction when recording is enabled', async () => {
    legacyServer = await startTestServer((_r, res) => {
      res.setHeader('set-cookie', 'session=secretcookie');
      replyJson(res, 200, { id: 1, token: 'SECRET-TOKEN' });
    });
    const scenario = loadScenarioFromText(
      `version: 1
id: rec.user
name: rec
service: s
tags: [recording]
mode: legacy_record
steps:
  - id: get
    request: { method: GET, path: /users/1 }
    recording:
      fixture: users/get.json
      safe_headers: [content-type]
`,
      'test.yaml',
    );
    const result = await runScenario(
      scenario,
      'test.yaml',
      config({ redaction: { headers: [], json_paths: ['$.token'], query_params: [] } }),
      registry,
      { recordingEnabled: true },
    );
    expect(result.pass).toBe(true);
    const fixture = readFileSync(join(reportDir, 'users/get.json'), 'utf8');
    expect(fixture).not.toContain('SECRET-TOKEN'); // body secret redacted
    expect(fixture).not.toContain('secretcookie'); // set-cookie not in safe_headers
    expect(fixture).toContain('content-type'); // safe header kept
  });

  it('does not write a recording when recording is disabled', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { id: 1 }));
    const scenario = loadScenarioFromText(
      `version: 1
id: rec.skip
name: skip
service: s
tags: [recording]
mode: legacy_record
steps:
  - id: get
    request: { method: GET, path: /users/1 }
    recording: { fixture: users/skip.json }
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry, {
      recordingEnabled: false,
    });
    expect(result.pass).toBe(true);
    expect(result.steps[0].recordingSkipped).toBe(true);
    expect(existsSync(join(reportDir, 'users/skip.json'))).toBe(false);
  });
});

describe('runScenario — replay_against_recording', () => {
  function writeFixture(name: string, body: unknown): void {
    const recording: Recording = {
      version: 1,
      scenarioId: 'seed',
      stepId: 'get',
      recordedAt: '2024-01-01T00:00:00.000Z',
      request: { method: 'GET', path: '/users/1' },
      response: {
        status: 200,
        headers: {},
        bodyText: JSON.stringify(body),
        bodyJson: body,
        durationMs: 1,
      },
    };
    writeRecording(reportDir, name, recording);
  }

  it('replays a recording against the new service and passes on parity', async () => {
    writeFixture('users/replay.json', { id: 1, name: 'A' });
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { id: 1, name: 'A' }));
    const scenario = loadScenarioFromText(
      `version: 1
id: rep.user
name: rep
service: s
tags: [regression]
mode: replay_against_recording
steps:
  - id: get
    recording: { fixture: users/replay.json }
    request: { method: GET, path: /users/1 }
    compare: { strategy: json_semantic, status: same }
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(true);
    expect(newServer.requests).toHaveLength(1);
  });

  it('fails when the new response diverges from the recording', async () => {
    writeFixture('users/mismatch.json', { id: 1, name: 'A' });
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { id: 1, name: 'B' }));
    const scenario = loadScenarioFromText(
      `version: 1
id: rep.mismatch
name: rep
service: s
tags: [regression]
mode: replay_against_recording
steps:
  - id: get
    recording: { fixture: users/mismatch.json }
    request: { method: GET, path: /users/1 }
    compare: { strategy: json_semantic, status: same }
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(false);
    expect(result.steps[0].comparison?.mismatches.some((m) => m.path === '$.name')).toBe(true);
  });

  it('resolves a recorded relative Location against the RECORDED request path', async () => {
    // The recording was captured on a different (deeper) path than the one the
    // parameterized replay sends, so a relative `Location` only resolves to the
    // target legacy actually named when the *recorded* path is the base.
    writeRecording(reportDir, 'users/location.json', {
      version: 1,
      scenarioId: 'seed',
      stepId: 'get',
      recordedAt: '2024-01-01T00:00:00.000Z',
      request: { method: 'GET', path: '/recorded/deep/users/1' },
      response: {
        status: 302,
        headers: { location: 'next' },
        bodyText: '{}',
        bodyJson: {},
        durationMs: 1,
      },
    });
    newServer = await startTestServer((_r, res) => {
      res.writeHead(302, {
        location: '/recorded/deep/users/next',
        'content-type': 'application/json',
      });
      res.end('{}');
    });
    const scenario = loadScenarioFromText(
      `version: 1
id: rep.location
name: rep
service: s
tags: [regression]
mode: replay_against_recording
steps:
  - id: get
    recording: { fixture: users/location.json }
    request: { method: GET, path: /live/1, follow_redirects: false }
    compare:
      strategy: json_semantic
      status: same
      location: { origin: ignore }
`,
      'test.yaml',
    );
    const result = await runScenario(
      scenario,
      'test.yaml',
      // Replay never calls legacy, but the recorded path still needs an origin
      // to resolve against.
      config({ legacy_base_url: 'http://legacy.example' }),
      registry,
    );
    // Resolved against the live path this would be /live/next — a location.path
    // mismatch instead of a pass.
    expect(result.steps[0].comparison?.mismatches ?? []).toEqual([]);
    expect(result.pass).toBe(true);
  });

  it('fails clearly when the replay fixture is missing', async () => {
    newServer = await startTestServer((_r, res) => replyJson(res, 200, {}));
    const scenario = loadScenarioFromText(
      `version: 1
id: rep.missing
name: missing
service: s
tags: [regression]
mode: replay_against_recording
steps:
  - id: get
    recording: { fixture: users/nope.json }
    request: { method: GET, path: /users/1 }
    compare: { strategy: json_semantic, status: same }
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(false);
    expect(result.steps[0].error).toMatch(/not found/);
  });
});

describe('runScenario — new_only_assert', () => {
  it('asserts explicit expectations against the new service only', async () => {
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { status: 'ok' }));
    const scenario = loadScenarioFromText(
      `version: 1
id: health.check
name: health
service: s
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
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(true);
  });
});

describe('runScenario — manual redirect chain', () => {
  it('walks a 30x hop by hop, replaying the Location and a captured cookie', async () => {
    newServer = await startTestServer((req, res) => {
      if (req.url === '/start') {
        res.statusCode = 302;
        res.setHeader('location', `${newServer?.url}/token?hop=1`);
        res.setHeader('set-cookie', ['csrf=c1; Path=/', 'sid=s1; Path=/; HttpOnly']);
        res.end();
        return;
      }
      replyJson(res, 200, { ok: true });
    });
    const scenario = loadScenarioFromText(
      `version: 1
id: oauth.chain
name: chain
service: s
tags: [smoke]
mode: new_only_assert
steps:
  - id: authorize
    request:
      method: GET
      path: /start
      follow_redirects: false
    extract:
      nextHop:
        from: response.headers
        path: location
      sid:
        from: response.set_cookie
        path: sid
    compare:
      strategy: explicit_expectations
      expect:
        status: 302
  - id: token
    request:
      method: POST
      path: "{{ variables.nextHop }}"
      form:
        grant_type: authorization_code
        session: "{{ variables.sid }}"
    compare:
      strategy: explicit_expectations
      expect:
        status: 200
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(true);
    // The 30x was observed rather than followed, so the chain is two requests.
    expect(newServer.requests.map((r) => r.url)).toEqual(['/start', '/token?hop=1']);
    const token = newServer.requests[1];
    expect(token.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(token.body))).toEqual({
      grant_type: 'authorization_code',
      session: 's1',
    });
  });
});

describe('runScenario — cookie jar (cookies: true)', () => {
  /** A server that 200s everything and hands out the given `Set-Cookie`s per request path. */
  async function jarServer(setCookie: Record<string, string[]>): Promise<TestServer> {
    return startTestServer((req, res) => {
      const cookies = setCookie[req.url];
      if (cookies) res.setHeader('set-cookie', cookies);
      replyJson(res, 200, { ok: true });
    });
  }

  /** The common login server: a root session cookie plus an /admin-scoped one. */
  function cookieServer(session: string): Promise<TestServer> {
    return jarServer({ '/login': [`sid=${session}; Path=/`, 'admin=ADM; Path=/admin'] });
  }

  /** These scenarios differ only in id, steps, and (rarely) mode or the opt-in. */
  function cookieScenario(
    id: string,
    steps: string,
    { mode = 'new_only_assert', cookies = true } = {},
  ) {
    return loadScenarioFromText(
      `version: 1
id: ${id}
name: ${id}
service: s
tags: [smoke]
mode: ${mode}
cookies: ${cookies}
steps:
${steps}`,
      'test.yaml',
    );
  }

  /** Log in, then request one path under the /admin-scoped cookie and one outside it. */
  const FLOW_STEPS = `  - id: login
    request: { method: POST, path: /login, body: { user: u } }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
  - id: admin
    request: { method: GET, path: /admin/panel }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
  - id: public
    request: { method: GET, path: /public }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
`;

  it('sends the jar cookies path-matched and most-specific-path-first', async () => {
    newServer = await cookieServer('SESSION');
    const scenario = cookieScenario('auth.flow', FLOW_STEPS);
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(true);
    // Nothing to send on the first request; then /admin/panel matches both
    // cookies (longest path first) and /public matches only the root one.
    expect(newServer.requests[0].headers.cookie).toBeUndefined();
    expect(newServer.requests[1].headers.cookie).toBe('admin=ADM; sid=SESSION');
    expect(newServer.requests[2].headers.cookie).toBe('sid=SESSION');
  });

  it('sends nothing without the opt-in', async () => {
    newServer = await cookieServer('SESSION');
    const scenario = cookieScenario('auth.flow', FLOW_STEPS, { cookies: false });
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(true);
    expect(newServer.requests.every((r) => r.headers.cookie === undefined)).toBe(true);
  });

  it('ingests cookies from a manual-redirect 30x response', async () => {
    newServer = await startTestServer((req, res) => {
      if (req.url === '/start') {
        res.statusCode = 302;
        res.setHeader('location', '/next');
        res.setHeader('set-cookie', ['hop=H1; Path=/']);
        res.end();
        return;
      }
      replyJson(res, 200, { ok: true });
    });
    const scenario = cookieScenario(
      'auth.hop',
      `  - id: start
    request: { method: GET, path: /start, follow_redirects: false }
    compare: { strategy: explicit_expectations, expect: { status: 302 } }
  - id: next
    request: { method: GET, path: /next }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
`,
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(true);
    expect(newServer.requests[1].headers.cookie).toBe('hop=H1');
  });

  it('lets an explicit Cookie header replace the jar while still ingesting the response', async () => {
    newServer = await jarServer({
      '/login': ['sid=SESSION; Path=/'],
      '/echo': ['fresh=F1; Path=/'],
    });
    const scenario = cookieScenario(
      'auth.explicit',
      `  - id: login
    request: { method: POST, path: /login, body: { user: u } }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
  - id: echo
    request:
      method: GET
      path: /echo
      headers: { Cookie: manual=MINE }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
  - id: after
    request: { method: GET, path: /after }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
`,
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(true);
    // The step's own header wins outright — the jar's sid is not merged in.
    expect(newServer.requests[1].headers.cookie).toBe('manual=MINE');
    // …but that response's Set-Cookie still landed in the jar, and the
    // explicit header never did.
    expect(newServer.requests[2].headers.cookie).toBe('sid=SESSION; fresh=F1');
  });

  it('keeps legacy and new jars independent in compare_live', async () => {
    legacyServer = await cookieServer('LEGACY');
    newServer = await cookieServer('NEW');
    const scenario = cookieScenario(
      'auth.both',
      `  - id: login
    request: { method: POST, path: /login, body: { user: u } }
    compare: { strategy: json_semantic, status: same }
  - id: profile
    request: { method: GET, path: /profile }
    compare: { strategy: json_semantic, status: same }
`,
      { mode: 'compare_live' },
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(true);
    expect(legacyServer.requests[1].headers.cookie).toBe('sid=LEGACY');
    expect(newServer.requests[1].headers.cookie).toBe('sid=NEW');
  });

  it('never writes a jar-sent cookie value into failure artifacts', async () => {
    newServer = await jarServer({ '/login': ['sid=SUPER-SECRET-SESSION; Path=/'] });
    const scenario = cookieScenario(
      'auth.leak',
      `  - id: login
    request: { method: POST, path: /login, body: { user: u } }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
  - id: profile
    request: { method: GET, path: /profile }
    compare: { strategy: explicit_expectations, expect: { status: 418 } }
`,
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(false);
    // The failing request really did carry the jar's cookie…
    expect(newServer.requests[1].headers.cookie).toBe('sid=SUPER-SECRET-SESSION');
    const artifacts = readArtifacts('auth.leak', 'profile');
    expect(artifacts).toContain(REDACTED);
    expect(artifacts).not.toContain('SUPER-SECRET-SESSION');
  });

  it('masks jar cookies in artifacts even when the config drops cookie redaction', async () => {
    newServer = await startTestServer((req, res) => {
      if (req.url === '/login') {
        res.setHeader('set-cookie', ['sid=SUPER-SECRET-SESSION; Path=/']);
      }
      replyJson(res, 200, { ok: true });
    });
    const scenario = loadScenarioFromText(
      `version: 1
id: auth.leak2
name: leak2
service: s
tags: [smoke]
mode: new_only_assert
cookies: true
steps:
  - id: login
    request: { method: POST, path: /login, body: { user: u } }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
  - id: profile
    request: { method: GET, path: /profile }
    compare: { strategy: explicit_expectations, expect: { status: 418 } }
`,
      'test.yaml',
    );
    // An operator who empties redaction.headers still cannot expose values the
    // jar put on the wire — the artifact writer masks cookies unconditionally.
    const result = await runScenario(
      scenario,
      'test.yaml',
      config({ redaction: { headers: [], json_paths: [], query_params: [] } }),
      registry,
    );
    expect(result.pass).toBe(false);
    expect(newServer.requests[1].headers.cookie).toBe('sid=SUPER-SECRET-SESSION');
    const artifacts = readArtifacts('auth.leak2', 'profile');
    expect(artifacts).toContain(REDACTED);
    expect(artifacts).not.toContain('SUPER-SECRET-SESSION');
  });
});
