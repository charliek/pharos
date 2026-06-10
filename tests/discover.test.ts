import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { discoverScenarioFiles, matchesFilter } from '../src/scenarios/discover';
import { loadScenarioFile } from '../src/scenarios/load';

const here = dirname(fileURLToPath(import.meta.url));
const scenarioDir = resolve(here, 'fixtures/valid/scenarios');

describe('discoverScenarioFiles', () => {
  it('finds yaml and json scenarios, sorted and absolute', () => {
    const files = discoverScenarioFiles(scenarioDir);
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.startsWith('/'))).toBe(true);
    expect(files).toEqual([...files].sort());
  });

  it('returns nothing for a missing directory', () => {
    expect(discoverScenarioFiles(resolve(here, 'does-not-exist'))).toEqual([]);
  });
});

describe('matchesFilter', () => {
  const scenario = loadScenarioFile(resolve(scenarioDir, 'get-user-success.yaml'));

  it('filters by scenario id', () => {
    expect(matchesFilter(scenario, { scenarioId: 'users.get-user-success' })).toBe(true);
    expect(matchesFilter(scenario, { scenarioId: 'other' })).toBe(false);
  });

  it('filters by include tag (any match)', () => {
    expect(matchesFilter(scenario, { includeTags: ['smoke'] })).toBe(true);
    expect(matchesFilter(scenario, { includeTags: ['write'] })).toBe(false);
  });

  it('filters by exclude tag (any match excludes)', () => {
    expect(matchesFilter(scenario, { excludeTags: ['smoke'] })).toBe(false);
    expect(matchesFilter(scenario, { excludeTags: ['write'] })).toBe(true);
  });

  it('matches everything with an empty filter', () => {
    expect(matchesFilter(scenario, {})).toBe(true);
  });
});
