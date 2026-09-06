import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { z } from 'zod';
import { jsonPathSchema } from '../comparison/rules';
import { readDocumentFile } from '../document';
import { ValidationError, validateWithSchema } from '../errors';
import { configFromEnv } from './env';

/**
 * Pharos configuration (spec Section 6): the shape of `pharos.config.json`/`.yaml`
 * **once loaded**, every field resolved. Field names are snake_case to match the
 * config file and the documented environment variables. Loading is layered:
 * defaults < config file < environment < CLI overrides. Mode-aware *semantic*
 * validation (e.g. compare_live needs both base URLs) is applied at run time by
 * the runner, not here.
 */

export interface RedactionTargets {
  headers: string[];
  json_paths: string[];
  query_params: string[];
}

export interface PharosConfig {
  legacy_base_url?: string;
  new_base_url?: string;
  scenario_dir: string;
  contract_dir: string;
  fixture_dir: string;
  report_dir: string;
  /** Module exporting the hook registry (hooks/comparators/normalizers). */
  hooks_module: string;
  default_timeout_ms: number;
  default_headers: Record<string, string>;
  output_mode: 'local' | 'ci';
  /**
   * The safety-relevant environment this run targets (spec Section 6.2).
   * Compared against scenario `safety.allowedEnvironments` (Section 4.5) —
   * independent of `output_mode`, which governs reporting/recording
   * conventions only. See Section 12 for the `production` fail-closed profile.
   */
  environment: 'local' | 'ci' | 'staging' | 'production';
  /**
   * Host globs (e.g. `*.example.com`) matched against the lowercase hostname
   * only of each configured base URL. A match while `environment !=
   * production` aborts the run before any request (spec Section 12).
   */
  production_url_patterns: string[];
  allow_destructive_tests: boolean;
  /** Additional guard required to run scenarios marked requiresProductionGuardOverride. */
  allow_production_guard_override: boolean;
  allow_recording_updates: boolean;
  /**
   * The run's scenario floor (spec Section 11.5): how many scenarios must
   * actually *execute* for the run to be trustworthy. Mirrors limen's
   * `min_comparisons`.
   *
   * **Required, like every other field on this interface.** `PharosConfig` is
   * the config *once loaded* (see the module docstring), where every field has
   * been resolved from defaults < file < env < CLI; the partial input shape is
   * {@link ConfigOverride}, and the default is {@link DEFAULT_MIN_SCENARIOS}.
   * Making the floor optional here would let a programmatic driver hand
   * `runProject` a config with no floor at all — a run with no denominator,
   * which is the hole this field closes. Adding it was a deliberate breaking
   * change for a consumer hand-building a loaded-config literal; spread
   * `defaultConfig()` instead of listing fields.
   *
   * **`0` and `1` behave identically.** `0` nominally opts out of the minimum,
   * but never out of the zero-execution guard — a run that executed nothing is
   * never a pass — and once that guard forces `executed >= 1`, a floor of 0 and
   * a floor of 1 are satisfied by exactly the same runs. `0` is therefore
   * accepted (it reads as "I am not asserting a size") and inert; do not
   * "restore" a meaning to it, and do not write a test claiming one, because
   * there is no input that distinguishes the two.
   */
  min_scenarios: number;
  redaction: RedactionTargets;
}

/**
 * Default floor: one scenario. A run that executed nothing used to print
 * `0 scenario(s): 0 passed …` and exit 0 (pharos#12), so the floor is on by
 * default rather than opt-in.
 */
export const DEFAULT_MIN_SCENARIOS = 1;

/** A partial config, as produced by a config file, env, or CLI flags. */
export interface ConfigOverride
  extends Partial<Omit<PharosConfig, 'redaction' | 'default_headers'>> {
  default_headers?: Record<string, string>;
  redaction?: Partial<RedactionTargets>;
}

export function defaultConfig(): PharosConfig {
  return {
    scenario_dir: './scenarios',
    contract_dir: './contracts',
    fixture_dir: './fixtures/recordings',
    report_dir: './reports',
    hooks_module: './hooks/index.ts',
    default_timeout_ms: 10_000,
    default_headers: {},
    output_mode: 'local',
    environment: 'local',
    production_url_patterns: [],
    allow_destructive_tests: false,
    allow_production_guard_override: false,
    allow_recording_updates: false,
    min_scenarios: DEFAULT_MIN_SCENARIOS,
    redaction: {
      headers: ['authorization', 'cookie', 'set-cookie', 'x-api-key'],
      json_paths: [],
      // `code` is an OAuth authorization code — a single-use credential that
      // travels in redirect Locations, so it is masked by default in both tools.
      query_params: ['access_token', 'code'],
    },
  };
}

const redactionFileSchema = z
  .object({
    headers: z.array(z.string()).optional(),
    json_paths: z.array(jsonPathSchema).optional(),
    query_params: z.array(z.string()).optional(),
  })
  .strict();

const configFileSchema = z
  .object({
    legacy_base_url: z.string().optional(),
    new_base_url: z.string().optional(),
    scenario_dir: z.string().optional(),
    contract_dir: z.string().optional(),
    fixture_dir: z.string().optional(),
    report_dir: z.string().optional(),
    hooks_module: z.string().optional(),
    default_timeout_ms: z.number().int().positive().optional(),
    default_headers: z.record(z.string()).optional(),
    output_mode: z.enum(['local', 'ci']).optional(),
    environment: z.enum(['local', 'ci', 'staging', 'production']).optional(),
    production_url_patterns: z.array(z.string().min(1)).optional(),
    allow_destructive_tests: z.boolean().optional(),
    allow_production_guard_override: z.boolean().optional(),
    allow_recording_updates: z.boolean().optional(),
    min_scenarios: z.number().int().nonnegative().optional(),
    redaction: redactionFileSchema.optional(),
  })
  .strict();

/** Layer one override on top of a base config, merging maps/redaction by field. */
export function mergeConfig(base: PharosConfig, override: ConfigOverride): PharosConfig {
  return {
    ...base,
    ...override,
    default_headers: { ...base.default_headers, ...(override.default_headers ?? {}) },
    redaction: { ...base.redaction, ...(override.redaction ?? {}) },
  };
}

const CONFIG_FILE_NAMES = ['pharos.config.json', 'pharos.config.yaml', 'pharos.config.yml'];

function findConfigFile(cwd: string): string | undefined {
  for (const name of CONFIG_FILE_NAMES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function readConfigFile(file: string): ConfigOverride {
  const ext = extname(file).toLowerCase();
  if (ext === '.ts' || ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    throw new ValidationError(file, [
      {
        path: '(config)',
        message:
          'TypeScript/JS config files are not supported yet — use pharos.config.json or .yaml',
      },
    ]);
  }
  return validateWithSchema(configFileSchema, readDocumentFile(file), file);
}

export interface LoadConfigOptions {
  /** Explicit config file path; otherwise auto-discovered in `cwd`. */
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Highest-precedence overrides (e.g. from CLI flags). */
  overrides?: ConfigOverride;
}

/**
 * Load configuration with full precedence: defaults < file < environment < CLI
 * overrides. Directory fields are resolved to absolute paths against `cwd`.
 */
export function loadConfig(options: LoadConfigOptions = {}): PharosConfig {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  let config = defaultConfig();

  const file = options.configPath ? resolve(cwd, options.configPath) : findConfigFile(cwd);
  if (file) {
    if (options.configPath && !existsSync(file)) {
      throw new ValidationError(file, [{ path: '(config)', message: 'config file not found' }]);
    }
    config = mergeConfig(config, readConfigFile(file));
  }

  config = mergeConfig(config, configFromEnv(env));
  if (options.overrides) {
    config = mergeConfig(config, options.overrides);
  }

  config.scenario_dir = resolve(cwd, config.scenario_dir);
  config.contract_dir = resolve(cwd, config.contract_dir);
  config.fixture_dir = resolve(cwd, config.fixture_dir);
  config.report_dir = resolve(cwd, config.report_dir);
  config.hooks_module = resolve(cwd, config.hooks_module);

  return config;
}
