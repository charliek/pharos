import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, type PharosConfig } from '../src/config/config';
import { ContractRegistry } from '../src/contract/load';
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
