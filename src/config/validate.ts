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

/** Escape regex metacharacters other than the glob wildcard itself. */
function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `*`-wildcard glob match against a lowercased hostname (spec Section 6.2/12). */
function hostnameMatchesGlob(hostname: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegExpLiteral).join('.*')}$`, 'i');
  return regex.test(hostname);
}

/**
 * `URL.hostname` wraps an IPv6 literal in brackets (`[2001:db8::1]`); strip
 * them so a pattern written in the conventional unbracketed form
 * (`2001:db8::1`, `2001:db8::*`) matches.
 */
function stripIPv6Brackets(hostname: string): string {
  if (hostname.length >= 2 && hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * `production_url_patterns` guard (spec Section 6.2/12): if any configured base
 * URL's hostname matches a configured pattern while `environment != production`,
 * abort before any request is issued. Also defensively rejects empty pattern
 * strings, regardless of environment. Wired into the `run`/`record` paths
 * (wherever {@link assertConfigForModes} runs) — `validate` never sends a
 * request, so it doesn't need this guard.
 */
export function assertProductionUrlGuard(config: PharosConfig): void {
  const patterns = config.production_url_patterns ?? [];
  const problems: string[] = [];

  for (const pattern of patterns) {
    if (typeof pattern !== 'string' || pattern.trim().length === 0) {
      problems.push(
        `production_url_patterns entries must be non-empty strings (got ${JSON.stringify(pattern)})`,
      );
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  if (config.environment === 'production' || patterns.length === 0) return;

  const candidates: Array<[field: string, url: string | undefined]> = [
    ['legacy_base_url', config.legacy_base_url],
    ['new_base_url', config.new_base_url],
  ];

  for (const [field, url] of candidates) {
    if (!url) continue;
    let hostname: string;
    try {
      hostname = stripIPv6Brackets(new URL(url).hostname.toLowerCase());
    } catch {
      // Fail closed: an unparseable base URL can't be verified as production-safe,
      // so treat it as a problem rather than silently skipping the check.
      problems.push(
        `${field} '${url}' could not be parsed as a URL; refusing to run without being able ` +
          'to verify it against production_url_patterns',
      );
      continue;
    }
    for (const pattern of patterns) {
      if (hostnameMatchesGlob(hostname, pattern)) {
        problems.push(
          `${field} '${url}' (hostname '${hostname}') matches production_url_patterns entry ` +
            `'${pattern}' but environment is '${config.environment}', not 'production' — ` +
            'refusing to run against a likely production host outside the production profile',
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
}
