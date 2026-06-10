import { ConfigError } from '../errors';
import type { ScenarioMode } from '../scenarios/schema';
import type { PharosConfig } from './config';

interface ModeRequirement {
  legacy: boolean;
  new: boolean;
  fixtures: boolean;
}

/**
 * What each mode needs from configuration (spec Section 6.3). Declared as an
 * exhaustive record so adding a mode to {@link ScenarioMode} forces a compile
 * error here until its requirements are stated — the mapping can never silently
 * fall out of date.
 *
 * | mode                       | legacy | new | fixtures |
 * |----------------------------|--------|-----|----------|
 * | compare_live               |   ✓    |  ✓  |          |
 * | legacy_record              |   ✓    |     |          |
 * | new_only_assert            |        |  ✓  |          |
 * | replay_against_recording   |        |  ✓  |    ✓     |
 */
const MODE_REQUIREMENTS: Record<ScenarioMode, ModeRequirement> = {
  compare_live: { legacy: true, new: true, fixtures: false },
  legacy_record: { legacy: true, new: false, fixtures: false },
  new_only_assert: { legacy: false, new: true, fixtures: false },
  replay_against_recording: { legacy: false, new: true, fixtures: true },
};

/**
 * Mode-aware semantic validation. Given the set of modes a run will exercise,
 * assert that the configuration carries the base URLs (and fixture directory)
 * each mode needs, failing with an actionable error rather than a confusing
 * network failure mid-run.
 */
export function assertConfigForModes(config: PharosConfig, modes: Iterable<ScenarioMode>): void {
  let needLegacy = false;
  let needNew = false;
  let needFixtures = false;
  for (const mode of modes) {
    const requirement = MODE_REQUIREMENTS[mode];
    needLegacy ||= requirement.legacy;
    needNew ||= requirement.new;
    needFixtures ||= requirement.fixtures;
  }

  const problems: string[] = [];
  if (needLegacy && !config.legacy_base_url) {
    problems.push(
      'legacy_base_url is required (set LEGACY_BASE_URL or legacy_base_url) for compare_live / legacy_record scenarios',
    );
  }
  if (needNew && !config.new_base_url) {
    problems.push(
      'new_base_url is required (set NEW_BASE_URL or new_base_url) for compare_live / new_only_assert / replay_against_recording scenarios',
    );
  }
  if (needFixtures && !config.fixture_dir) {
    problems.push('fixture_dir is required for replay_against_recording scenarios');
  }
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
}
