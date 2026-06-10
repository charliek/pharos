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
