import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultConfig, loadConfig } from '../src/config/config';
import { configFromEnv } from '../src/config/env';

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
});

describe('loadConfig precedence (defaults < file < env < overrides)', () => {
  it('returns documented defaults with no inputs', () => {
    const config = loadConfig({ env: {}, cwd: here });
    expect(config.output_mode).toBe('local');
    expect(config.allow_destructive_tests).toBe(false);
    expect(config.redaction.headers).toContain('authorization');
  });

  it('reads values from a config file', () => {
    const config = loadConfig({ configPath: configFile, env: {}, cwd: here });
    expect(config.legacy_base_url).toBe('http://file-legacy');
    expect(config.default_timeout_ms).toBe(1234);
    expect(config.scenario_dir.endsWith('from-file-scenarios')).toBe(true);
    // partial redaction override replaces only the named field
    expect(config.redaction.headers).toEqual(['x-secret']);
    expect(config.redaction.query_params).toEqual(['access_token']);
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
});
