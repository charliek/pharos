import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig } from '../src/config/config';
import { configFromEnv } from '../src/config/env';
import { ConfigError, ValidationError } from '../src/errors';

const here = dirname(fileURLToPath(import.meta.url));
const configFile = resolve(here, 'fixtures/config/pharos.config.json');

describe('configFromEnv', () => {
  it('projects recognized variables only', () => {
    const result = configFromEnv({
      LEGACY_BASE_URL: 'http://legacy',
      ALLOW_DESTRUCTIVE_TESTS: 'true',
      PHAROS_MODE: 'ci',
      UNRELATED: 'ignored',
    } as NodeJS.ProcessEnv);
    expect(result).toEqual({
      legacy_base_url: 'http://legacy',
      allow_destructive_tests: true,
      output_mode: 'ci',
    });
  });

  it('parses boolean-ish values', () => {
    expect(configFromEnv({ ALLOW_RECORDING_UPDATES: '1' } as NodeJS.ProcessEnv)).toEqual({
      allow_recording_updates: true,
    });
    expect(configFromEnv({ ALLOW_RECORDING_UPDATES: 'no' } as NodeJS.ProcessEnv)).toEqual({
      allow_recording_updates: false,
    });
  });

  it('projects PHAROS_ENVIRONMENT independently of PHAROS_MODE', () => {
    expect(configFromEnv({ PHAROS_ENVIRONMENT: 'production' } as NodeJS.ProcessEnv)).toEqual({
      environment: 'production',
    });
    expect(
      configFromEnv({ PHAROS_ENVIRONMENT: 'staging', PHAROS_MODE: 'ci' } as NodeJS.ProcessEnv),
    ).toEqual({ environment: 'staging', output_mode: 'ci' });
  });

  it('fails closed (ConfigError) on an unrecognized PHAROS_ENVIRONMENT value, never silently ignoring it', () => {
    try {
      configFromEnv({ PHAROS_ENVIRONMENT: 'prod' } as NodeJS.ProcessEnv);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('prod');
      expect(message).toContain('local');
      expect(message).toContain('ci');
      expect(message).toContain('staging');
      expect(message).toContain('production');
    }
  });

  it('fails closed on an empty PHAROS_ENVIRONMENT value', () => {
    expect(() => configFromEnv({ PHAROS_ENVIRONMENT: '' } as NodeJS.ProcessEnv)).toThrow(
      ConfigError,
    );
  });

  it('projects MIN_SCENARIOS as the run floor, including the 0 opt-out', () => {
    expect(configFromEnv({ MIN_SCENARIOS: '3' } as NodeJS.ProcessEnv)).toEqual({
      min_scenarios: 3,
    });
    expect(configFromEnv({ MIN_SCENARIOS: '0' } as NodeJS.ProcessEnv)).toEqual({
      min_scenarios: 0,
    });
    expect(configFromEnv({ MIN_SCENARIOS: '  5  ' } as NodeJS.ProcessEnv)).toEqual({
      min_scenarios: 5,
    });
  });

  it('fails closed (ConfigError) on a garbage MIN_SCENARIOS rather than defaulting to 1', () => {
    // A floor that silently became the default would be a fresh false green —
    // the exact failure mode the floor exists to catch (pharos#12).
    for (const value of ['abc', '-1', '1.5', '', '  ']) {
      expect(() => configFromEnv({ MIN_SCENARIOS: value } as NodeJS.ProcessEnv)).toThrow(
        ConfigError,
      );
    }
    try {
      configFromEnv({ MIN_SCENARIOS: 'abc' } as NodeJS.ProcessEnv);
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigError).message).toContain('MIN_SCENARIOS');
      expect((error as ConfigError).message).toContain('abc');
    }
  });

  it('refuses a MIN_SCENARIOS floor it cannot represent exactly, at the boundary', () => {
    // `99999999999999999999` passes a digits-only test and becomes 1e20 — a
    // floor the runtime cannot count to. It fails closed as an unmeetable floor
    // either way, but a number pharos cannot represent is refused where it is
    // stated, naming the value, rather than silently gated on an approximation.
    expect(configFromEnv({ MIN_SCENARIOS: '9007199254740991' } as NodeJS.ProcessEnv)).toEqual({
      min_scenarios: Number.MAX_SAFE_INTEGER,
    });
    for (const value of ['9007199254740992', '99999999999999999999']) {
      expect(() => configFromEnv({ MIN_SCENARIOS: value } as NodeJS.ProcessEnv)).toThrow(
        ConfigError,
      );
    }
    try {
      configFromEnv({ MIN_SCENARIOS: '99999999999999999999' } as NodeJS.ProcessEnv);
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigError).message).toContain('MIN_SCENARIOS');
      expect((error as ConfigError).message).toContain('99999999999999999999');
      expect((error as ConfigError).message).toContain(String(Number.MAX_SAFE_INTEGER));
    }
  });

  it('trims surrounding whitespace before validating PHAROS_ENVIRONMENT', () => {
    expect(configFromEnv({ PHAROS_ENVIRONMENT: '  production  ' } as NodeJS.ProcessEnv)).toEqual({
      environment: 'production',
    });
  });
});

describe('loadConfig precedence (defaults < file < env < overrides)', () => {
  it('returns documented defaults with no inputs', () => {
    const config = loadConfig({ env: {}, cwd: here });
    expect(config.output_mode).toBe('local');
    expect(config.environment).toBe('local');
    expect(config.production_url_patterns).toEqual([]);
    expect(config.allow_destructive_tests).toBe(false);
    expect(config.redaction.headers).toContain('authorization');
  });

  it('reads environment and production_url_patterns from the config file', () => {
    const config = loadConfig({
      configPath: resolve(here, 'fixtures/config/pharos.config.environment.json'),
      env: {},
      cwd: here,
    });
    expect(config.environment).toBe('staging');
    expect(config.production_url_patterns).toEqual(['*.example.com']);
  });

  it('rejects an invalid environment value in the config file with a clear error', () => {
    try {
      loadConfig({
        configPath: resolve(here, 'fixtures/config/pharos.config.bad-environment.json'),
        env: {},
        cwd: here,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      const issues = (error as ValidationError).issues;
      expect(issues.some((issue) => issue.path === 'environment')).toBe(true);
      // zod's enum message names the invalid value and/or the valid options.
      expect(issues.some((issue) => /production|staging|ci|local|enum/i.test(issue.message))).toBe(
        true,
      );
    }
  });

  it('lets PHAROS_ENVIRONMENT override the file, and CLI overrides win over both', () => {
    const config = loadConfig({
      configPath: resolve(here, 'fixtures/config/pharos.config.environment.json'),
      env: { PHAROS_ENVIRONMENT: 'ci' } as NodeJS.ProcessEnv,
      cwd: here,
    });
    expect(config.environment).toBe('ci');

    const overridden = loadConfig({
      configPath: resolve(here, 'fixtures/config/pharos.config.environment.json'),
      env: { PHAROS_ENVIRONMENT: 'ci' } as NodeJS.ProcessEnv,
      overrides: { environment: 'production' },
      cwd: here,
    });
    expect(overridden.environment).toBe('production');
  });

  it('reads values from a config file', () => {
    const config = loadConfig({ configPath: configFile, env: {}, cwd: here });
    expect(config.legacy_base_url).toBe('http://file-legacy');
    expect(config.default_timeout_ms).toBe(1234);
    expect(config.scenario_dir.endsWith('from-file-scenarios')).toBe(true);
    // partial redaction override replaces only the named field
    expect(config.redaction.headers).toEqual(['x-secret']);
    // …leaving the built-in secret-bearing query params (incl. the OAuth `code`)
    expect(config.redaction.query_params).toEqual(['access_token', 'code']);
  });

  it('lets the environment override the file', () => {
    const config = loadConfig({
      configPath: configFile,
      env: { LEGACY_BASE_URL: 'http://env-legacy' } as NodeJS.ProcessEnv,
      cwd: here,
    });
    expect(config.legacy_base_url).toBe('http://env-legacy');
  });

  it('lets explicit overrides win over file and env', () => {
    const config = loadConfig({
      configPath: configFile,
      env: { LEGACY_BASE_URL: 'http://env-legacy' } as NodeJS.ProcessEnv,
      overrides: { legacy_base_url: 'http://override-legacy' },
      cwd: here,
    });
    expect(config.legacy_base_url).toBe('http://override-legacy');
  });

  it('reads min_scenarios from the config file, with env and overrides winning in turn', () => {
    const fromFile = loadConfig({
      configPath: resolve(here, 'fixtures/config/pharos.config.min-scenarios.json'),
      env: {},
      cwd: here,
    });
    expect(fromFile.min_scenarios).toBe(7);

    const fromEnv = loadConfig({
      configPath: resolve(here, 'fixtures/config/pharos.config.min-scenarios.json'),
      env: { MIN_SCENARIOS: '9' } as NodeJS.ProcessEnv,
      cwd: here,
    });
    expect(fromEnv.min_scenarios).toBe(9);

    const overridden = loadConfig({
      configPath: resolve(here, 'fixtures/config/pharos.config.min-scenarios.json'),
      env: { MIN_SCENARIOS: '9' } as NodeJS.ProcessEnv,
      overrides: { min_scenarios: 2 },
      cwd: here,
    });
    expect(overridden.min_scenarios).toBe(2);
  });

  it('defaults the run floor to one executed scenario', () => {
    expect(loadConfig({ env: {}, cwd: here }).min_scenarios).toBe(1);
    expect(defaultConfig().min_scenarios).toBe(1);
  });

  it('resolves directory fields to absolute paths', () => {
    const config = loadConfig({ env: {}, cwd: here });
    expect(config.scenario_dir.startsWith('/')).toBe(true);
    expect(config.contract_dir.startsWith('/')).toBe(true);
  });
});

describe('defaultConfig', () => {
  it('is independent across calls (no shared mutable state)', () => {
    const a = defaultConfig();
    a.redaction.headers.push('mutated');
    expect(defaultConfig().redaction.headers).not.toContain('mutated');
  });

  it('refuses a config-file floor beyond the safe integer range', () => {
    // The two string-parsing entry points reject an unrepresentable floor; a
    // config file must not be the door left open. zod's `.int()` alone is
    // `Number.isInteger`, which accepts 1e20.
    const dir = mkdtempSync(join(tmpdir(), 'pharos-cfg-floor-'));
    const file = join(dir, 'pharos.config.json');
    writeFileSync(file, JSON.stringify({ min_scenarios: 1e20 }));
    expect(() => loadConfig({ configPath: file, cwd: dir, env: {} })).toThrow();
    writeFileSync(file, JSON.stringify({ min_scenarios: Number.MAX_SAFE_INTEGER }));
    expect(loadConfig({ configPath: file, cwd: dir, env: {} }).min_scenarios).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});
