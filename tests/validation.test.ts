import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config';
import { validateProject } from '../src/validation';

const here = dirname(fileURLToPath(import.meta.url));

function configFor(scenarioDir: string, contractDir: string) {
  return loadConfig({
    env: {},
    cwd: here,
    overrides: {
      scenario_dir: resolve(here, scenarioDir),
      contract_dir: resolve(here, contractDir),
    },
  });
}

describe('validateProject', () => {
  it('reports a valid project with resolvable contract references', () => {
    const report = validateProject(
      configFor('fixtures/valid/scenarios', 'fixtures/valid/contracts'),
    );
    expect(report.invalid).toBe(0);
    // 2 scenarios + 1 contract file
    expect(report.valid).toBe(3);
    expect(report.results.filter((r) => r.kind === 'scenario')).toHaveLength(2);
  });

  it('reports invalid scenarios with field-addressed issues', () => {
    const report = validateProject(
      configFor('fixtures/invalid/scenarios', 'fixtures/invalid/contracts'),
    );
    expect(report.invalid).toBeGreaterThan(0);
    const bad = report.results.find((r) => r.file.endsWith('bad-mode.yaml'));
    expect(bad?.ok).toBe(false);
    expect(bad?.issues.some((i) => i.path === 'mode')).toBe(true);
  });

  it('returns an empty report for empty directories', () => {
    const report = validateProject(configFor('fixtures/empty', 'fixtures/empty'));
    expect(report.results).toEqual([]);
    expect(report.invalid).toBe(0);
  });
});
