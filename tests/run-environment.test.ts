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

/**
 * `environment` vs. `allowedEnvironments` (spec Sections 4.5 + 11.5 + 12):
 * skips outside production, refusals (distinct failing results) inside it,
 * and the "tagged [production] alone silently skips everywhere else" trap.
 */

const here = dirname(fileURLToPath(import.meta.url));
const scenarioDir = resolve(here, 'fixtures/run-environment/scenarios');

let legacyServer: TestServer | undefined;
let newServer: TestServer | undefined;
let reportDir: string;

beforeEach(async () => {
  reportDir = mkdtempSync(join(tmpdir(), 'pharos-run-environment-'));
  legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
  newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
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

function findScenario(scenarios: ReturnType<typeof buildReport>['scenarios'], id: string) {
  const found = scenarios.find((s) => s.scenarioId === id);
  if (!found) throw new Error(`scenario ${id} not found in report`);
  return found;
}

describe('environment vs. allowedEnvironments — non-production (skip, not refusal)', () => {
  it('runs an untagged scenario and one tagged for the current environment', async () => {
    const { results, accounting } = await runProject(config({ environment: 'local' }), {});
    const report = buildReport(results, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', accounting);

    expect(findScenario(report.scenarios, 'env.everywhere').pass).toBe(true);
    expect(findScenario(report.scenarios, 'env.non-production').pass).toBe(true);
    expect(findScenario(report.scenarios, 'env.untagged').pass).toBe(true);
  });

  it('skips (not fails) a scenario tagged [production] alone, counted only under skipped', async () => {
    const { results, accounting } = await runProject(config({ environment: 'local' }), {});
    const report = buildReport(results, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', accounting);

    const productionOnly = findScenario(report.scenarios, 'env.production-only');
    expect(productionOnly.skipped).toBe(true);
    expect(productionOnly.pass).toBe(true); // skipped, not counted as coverage
    expect(report.summary.skipped).toBe(1);
    expect(report.summary.passed).toBe(3); // everywhere, non-production, untagged — not the skip
    expect(report.summary.failed).toBe(0);
    expect(exitCodeFor(report)).toBe(0); // a skip never fails the run
  });

  it('staging also treats a non-production tag as eligible', async () => {
    const { results } = await runProject(config({ environment: 'staging' }), {
      scenarioId: 'env.non-production',
    });
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(false);
    expect(results[0].pass).toBe(true);
  });
});

describe('environment: production — fail-closed refusal, not skip', () => {
  it('refuses an untagged scenario as a distinct failing result', async () => {
    const { results } = await runProject(config({ environment: 'production' }), {
      scenarioId: 'env.untagged',
    });
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(false);
    expect(results[0].pass).toBe(false);
    expect(results[0].error).toMatch(/refused/);
    expect(results[0].error).toMatch(/production/);
  });

  it('refuses a scenario tagged only for local/ci/staging', async () => {
    const { results } = await runProject(config({ environment: 'production' }), {
      scenarioId: 'env.non-production',
    });
    expect(results[0].skipped).toBe(false);
    expect(results[0].pass).toBe(false);
  });

  it('runs a scenario explicitly tagged for production', async () => {
    const { results } = await runProject(config({ environment: 'production' }), {
      scenarioId: 'env.everywhere',
    });
    expect(results[0].skipped).toBe(false);
    expect(results[0].pass).toBe(true);
  });

  it('runs a scenario tagged [production] only', async () => {
    const { results } = await runProject(config({ environment: 'production' }), {
      scenarioId: 'env.production-only',
    });
    expect(results[0].skipped).toBe(false);
    expect(results[0].pass).toBe(true);
  });

  it('refusals fail the run (non-zero exit) while any skip alone would not', async () => {
    const { results, accounting } = await runProject(config({ environment: 'production' }), {});
    const report = buildReport(results, '2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z', accounting);

    expect(report.summary.skipped).toBe(0);
    expect(report.summary.failed).toBe(2); // untagged + non-production refused
    expect(report.summary.passed).toBe(2); // everywhere + production-only
    expect(exitCodeFor(report)).toBe(1);
  });
});

describe('production_url_patterns — aborts before any request is issued', () => {
  it('throws ConfigError and sends zero requests when a base URL hostname matches', async () => {
    const hostname = new URL(newServer?.url ?? '').hostname; // 127.0.0.1
    await expect(
      runProject(config({ environment: 'local', production_url_patterns: [hostname] }), {}),
    ).rejects.toThrow(ConfigError);
    expect(legacyServer?.requests).toHaveLength(0);
    expect(newServer?.requests).toHaveLength(0);
  });

  it('does not throw when environment is production, even with a matching pattern', async () => {
    const hostname = new URL(newServer?.url ?? '').hostname;
    const { results } = await runProject(
      config({ environment: 'production', production_url_patterns: [hostname] }),
      { scenarioId: 'env.everywhere' },
    );
    expect(results[0].pass).toBe(true);
  });
});

describe('accounting hole: a tag filter erasing an explicitly-named --scenario', () => {
  it('exits 20 instead of silently dropping a would-be production refusal (false green)', async () => {
    // env.non-production carries tag 'read' but not 'smoke'; excluding 'read'
    // erases it from the run set entirely — including the refusal it would
    // otherwise have produced under environment: production. Without the
    // accounting fix this returns zero results and a green (exit 0) report.
    //
    // It is a floor outcome, not a ConfigError: the throw exited 1 before any
    // report was written, while a `--scenario` the safety gate blocks exits 20
    // with both reports on disk — one operator mistake, one exit code.
    const cfg = config({ environment: 'production' });
    const { results, accounting } = await runProject(cfg, {
      scenarioId: 'env.non-production',
      excludeTags: ['read'],
    });
    const report = buildReport(
      results,
      '2024-01-01T00:00:00Z',
      '2024-01-01T00:00:00Z',
      accounting,
      cfg,
    );
    expect(report.summary.executed).toBe(0);
    expect(exitCodeFor(report)).toBe(20);
    expect(report.summary.floor.reason).toContain('env.non-production');
    expect(report.summary.floor.reason).toMatch(/filtered/);
    expect(legacyServer?.requests).toHaveLength(0);
    expect(newServer?.requests).toHaveLength(0);
  });
});
