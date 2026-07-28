import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { z } from 'zod';
import { jsonPathSchema } from '../comparison/rules';
import { readDocumentFile } from '../document';
import { ValidationError, validateWithSchema } from '../errors';
import { configFromEnv } from './env';

/**
 * Pharos configuration (spec Section 6). Field names are snake_case to match the
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
  redaction: RedactionTargets;
}

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
    redaction: {
      headers: ['authorization', 'cookie', 'set-cookie', 'x-api-key'],
      json_paths: [],
      query_params: ['access_token'],
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
