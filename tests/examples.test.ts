import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type MockServer, startUserApiServer } from '../examples/mock-service';
import { defaultConfig, type PharosConfig } from '../src/config/config';
import { runProject } from '../src/execution/run-all';
import { buildReport } from '../src/reporting/report';

/**
 * End-to-end check that the shipped example scenarios, contract, hooks, and
 * recording all run against the mock service (spec Section 15 / Phase 8 "done
 * when example scenarios run against mock endpoints").
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

let legacy: MockServer | undefined;
let newService: MockServer | undefined;
let reportDir: string;

beforeEach(async () => {
  legacy = await startUserApiServer();
  newService = await startUserApiServer();
  reportDir = mkdtempSync(join(tmpdir(), 'pharos-examples-'));
});

afterEach(async () => {
  await legacy?.close();
  await newService?.close();
});

function exampleConfig(): PharosConfig {
  return {
    ...defaultConfig(),
    scenario_dir: join(repoRoot, 'scenarios'),
    contract_dir: join(repoRoot, 'contracts'),
    fixture_dir: join(repoRoot, 'fixtures/recordings'),
    hooks_module: join(repoRoot, 'hooks/index.ts'),
    legacy_base_url: legacy?.url,
    new_base_url: newService?.url,
    report_dir: reportDir,
    allow_destructive_tests: true,
  };
}

describe('example scenarios', () => {
  it('all run green against the mock service', async () => {
    const env = {
      ...process.env,
      LEGACY_BASE_URL: legacy?.url,
      NEW_BASE_URL: newService?.url,
    } as NodeJS.ProcessEnv;

    const results = await runProject(exampleConfig(), { env });
    const report = buildReport(results, '2024-01-01T00:00:00Z', '2024-01-01T00:00:01Z');

    // The seven required example scenarios are present.
    expect(report.summary.total).toBeGreaterThanOrEqual(7);
    // None fail (a couple may be skipped only if guards apply — here none do).
    const failed = report.scenarios.filter((s) => !s.pass && !s.skipped);
    expect(failed.map((s) => `${s.scenarioId}: ${s.error ?? 'mismatch'}`)).toEqual([]);
    expect(report.summary.failed).toBe(0);
  });

  it('runs the multi-step destructive flow when opted in', async () => {
    const env = {
      ...process.env,
      LEGACY_BASE_URL: legacy?.url,
      NEW_BASE_URL: newService?.url,
    } as NodeJS.ProcessEnv;
    const results = await runProject(exampleConfig(), {
      scenarioId: 'users.create-then-fetch-destructive',
      env,
    });
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(false);
    expect(results[0].pass).toBe(true);
    expect(results[0].steps).toHaveLength(2);
  });
});
