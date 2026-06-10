import fg from 'fast-glob';
import type { Scenario } from './schema';

const DEFAULT_PATTERNS = ['**/*.yaml', '**/*.yml', '**/*.json'];

/**
 * Find YAML/JSON files under `dir`. Returns absolute paths, sorted for
 * deterministic ordering. A missing directory simply yields no files. Shared by
 * scenario and contract discovery.
 */
export function discoverFiles(dir: string, patterns: string[] = DEFAULT_PATTERNS): string[] {
  return fg.sync(patterns, { cwd: dir, absolute: true, onlyFiles: true, dot: false }).sort();
}

/** Find scenario files under `scenarioDir` (absolute, sorted). */
export function discoverScenarioFiles(
  scenarioDir: string,
  patterns: string[] = DEFAULT_PATTERNS,
): string[] {
  return discoverFiles(scenarioDir, patterns);
}

export interface ScenarioFilter {
  scenarioId?: string;
  includeTags?: string[];
  excludeTags?: string[];
}

/** Whether a scenario passes id + tag filters (spec Section 4.8 / CLI filtering). */
export function matchesFilter(scenario: Scenario, filter: ScenarioFilter): boolean {
  if (filter.scenarioId && scenario.id !== filter.scenarioId) {
    return false;
  }
  if (filter.includeTags?.length) {
    const included = filter.includeTags.some((tag) => scenario.tags.includes(tag));
    if (!included) return false;
  }
  if (filter.excludeTags?.length) {
    const excluded = filter.excludeTags.some((tag) => scenario.tags.includes(tag));
    if (excluded) return false;
  }
  return true;
}
