import { ConfigError } from '../errors';
import type { ConfigOverride } from './config';

const VALID_ENVIRONMENTS = ['local', 'ci', 'staging', 'production'] as const;
type Environment = (typeof VALID_ENVIRONMENTS)[number];

function isValidEnvironment(value: string): value is Environment {
  return (VALID_ENVIRONMENTS as readonly string[]).includes(value);
}

/** Parse a boolean-ish env value; returns undefined when unset/unrecognized. */
function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === '') {
    return false;
  }
  return undefined;
}

/**
 * Project the recognized Pharos environment variables (spec Section 6.2) into a
 * config override. Only set keys are returned, so this layers cleanly over the
 * config file and under CLI arguments.
 *
 * `PHAROS_ENVIRONMENT` is safety-relevant (Section 12), so an unrecognized
 * value throws {@link ConfigError} naming the value and the valid options
 * rather than silently falling back to the `local` default (fail-closed:
 * `PHAROS_ENVIRONMENT=prod` must not quietly become `local`). Surrounding
 * whitespace is trimmed before validation.
 */
export function configFromEnv(env: NodeJS.ProcessEnv): ConfigOverride {
  const out: ConfigOverride = {};
  if (env.LEGACY_BASE_URL) out.legacy_base_url = env.LEGACY_BASE_URL;
  if (env.NEW_BASE_URL) out.new_base_url = env.NEW_BASE_URL;
  if (env.SCENARIO_DIR) out.scenario_dir = env.SCENARIO_DIR;
  if (env.CONTRACT_DIR) out.contract_dir = env.CONTRACT_DIR;
  if (env.FIXTURE_DIR) out.fixture_dir = env.FIXTURE_DIR;
  if (env.REPORT_DIR) out.report_dir = env.REPORT_DIR;

  if (env.DEFAULT_TIMEOUT_MS) {
    const parsed = Number(env.DEFAULT_TIMEOUT_MS);
    if (Number.isFinite(parsed) && parsed > 0) out.default_timeout_ms = parsed;
  }
  if (env.PHAROS_MODE === 'local' || env.PHAROS_MODE === 'ci') {
    out.output_mode = env.PHAROS_MODE;
  }
  if (env.PHAROS_ENVIRONMENT !== undefined) {
    const trimmed = env.PHAROS_ENVIRONMENT.trim();
    if (!isValidEnvironment(trimmed)) {
      throw new ConfigError([
        `PHAROS_ENVIRONMENT must be one of ${VALID_ENVIRONMENTS.join(', ')} ` +
          `(got ${JSON.stringify(env.PHAROS_ENVIRONMENT)})`,
      ]);
    }
    out.environment = trimmed;
  }

  const destructive = parseBool(env.ALLOW_DESTRUCTIVE_TESTS);
  if (destructive !== undefined) out.allow_destructive_tests = destructive;
  const productionGuard = parseBool(env.ALLOW_PRODUCTION_GUARD_OVERRIDE);
  if (productionGuard !== undefined) out.allow_production_guard_override = productionGuard;
  const recording = parseBool(env.ALLOW_RECORDING_UPDATES);
  if (recording !== undefined) out.allow_recording_updates = recording;

  return out;
}
