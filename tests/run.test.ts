import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, type PharosConfig } from '../src/config/config';
import { ConfigError } from '../src/errors';
import { runProject } from '../src/execution/run-all';
import { buildReport, exitCodeFor } from '../src/reporting/report';
import { replyJson, startTestServer, type TestServer } from './helpers/server';

const here = dirname(fileURLToPath(import.meta.url));
const scenarioDir = resolve(here, 'fixtures/run/scenarios');

let legacyServer: TestServer | undefined;
let newServer: TestServer | undefined;
let reportDir: string;

beforeEach(() => {
  reportDir = mkdtempSync(join(tmpdir(), 'pharos-run-'));
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
    scenario_dir: scenarioDir,
    legacy_base_url: legacyServer?.url,
    new_base_url: newServer?.url,
    report_dir: reportDir,
    hooks_module: resolve(here, 'fixtures/run/no-hooks.ts'), // does not exist → empty registry
    ...overrides,
  };
}

describe('runProject — the run pipeline', () => {
  it('runs reads and skips destructive scenarios without opt-in', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const results = await runProject(config(), {});
    const report = buildReport(results, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
    expect(report.summary.total).toBe(2);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.skipped).toBe(1);
    expect(report.summary.failed).toBe(0);
    expect(exitCodeFor(report)).toBe(0);
    const destructive = report.scenarios.find((s) => s.scenarioId === 'run.destructive');
    expect(destructive?.skipped).toBe(true);
  });

  it('filters to a single scenario by id', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const results = await runProject(config(), { scenarioId: 'run.ok' });
    expect(results).toHaveLength(1);
    expect(results[0].scenarioId).toBe('run.ok');
  });

  it('filters by tag', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const included = await runProject(config(), { includeTags: ['smoke'] });
    expect(included.map((r) => r.scenarioId)).toEqual(['run.ok']);
    const excluded = await runProject(config(), { excludeTags: ['destructive'] });
    expect(excluded.map((r) => r.scenarioId)).toEqual(['run.ok']);
  });

  it('reports a failure and yields a non-zero exit code', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: false }));
    const results = await runProject(config(), { scenarioId: 'run.ok' });
    const report = buildReport(results, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z');
    expect(report.summary.failed).toBe(1);
    expect(exitCodeFor(report)).toBe(1);
  });

  it('runs destructive scenarios when opted in', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const results = await runProject(config({ allow_destructive_tests: true }), {
      scenarioId: 'run.destructive',
    });
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(false);
    expect(results[0].pass).toBe(true);
  });

  it('skips a scenario requiring the production guard override unless overridden', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const guardDir = resolve(here, 'fixtures/run-guard/scenarios');
    const skipped = await runProject(
      config({ scenario_dir: guardDir, allow_destructive_tests: true }),
      {},
    );
    expect(skipped[0].skipped).toBe(true);
    expect(skipped[0].skipReason).toMatch(/production guard/);

    const allowed = await runProject(
      config({
        scenario_dir: guardDir,
        allow_destructive_tests: true,
        allow_production_guard_override: true,
      }),
      {},
    );
    expect(allowed[0].skipped).toBe(false);
    expect(allowed[0].pass).toBe(true);
  });

  it('errors instead of silently reporting nothing when --scenario names an id that does not exist', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    try {
      await runProject(config(), { scenarioId: 'run.does-not-exist' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('run.does-not-exist');
    }
    // Fail-closed before any request work.
    expect(legacyServer.requests).toHaveLength(0);
    expect(newServer.requests).toHaveLength(0);
  });

  it('errors instead of silently reporting nothing when a tag filter erases the named --scenario', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    // run.ok carries tag 'smoke'; excluding it erases the only scenario --scenario named.
    try {
      await runProject(config(), { scenarioId: 'run.ok', excludeTags: ['smoke'] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('run.ok');
      expect(message).toMatch(/filtered/);
    }
    expect(legacyServer.requests).toHaveLength(0);
    expect(newServer.requests).toHaveLength(0);
  });

  it('mentions the parse failure when --scenario names a file that failed to parse', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const brokenDir = resolve(here, 'fixtures/run-parse-failure/scenarios');
    try {
      await runProject(config({ scenario_dir: brokenDir }), { scenarioId: 'run.broken' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('run.broken');
      expect(message).toMatch(/parse/i);
    }
    // Fail-closed before any request work, same as the other accounting-hole cases.
    expect(legacyServer.requests).toHaveLength(0);
    expect(newServer.requests).toHaveLength(0);
  });

  it('still runs normally when --scenario is named and no tag filter conflicts with it', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const results = await runProject(config(), {
      scenarioId: 'run.ok',
      includeTags: ['smoke'],
    });
    expect(results).toHaveLength(1);
    expect(results[0].scenarioId).toBe('run.ok');
  });
});
