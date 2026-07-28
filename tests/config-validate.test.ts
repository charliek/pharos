import { describe, expect, it } from 'vitest';
import { defaultConfig, type PharosConfig } from '../src/config/config';
import { assertConfigForModes, assertProductionUrlGuard } from '../src/config/validate';
import { ConfigError } from '../src/errors';

function configWith(overrides: Partial<PharosConfig>): PharosConfig {
  return { ...defaultConfig(), ...overrides };
}

describe('assertConfigForModes', () => {
  it('requires both base URLs for compare_live', () => {
    expect(() => assertConfigForModes(configWith({}), ['compare_live'])).toThrow(ConfigError);
    expect(() =>
      assertConfigForModes(configWith({ legacy_base_url: 'http://l', new_base_url: 'http://n' }), [
        'compare_live',
      ]),
    ).not.toThrow();
  });

  it('requires only legacy for legacy_record', () => {
    expect(() =>
      assertConfigForModes(configWith({ legacy_base_url: 'http://l' }), ['legacy_record']),
    ).not.toThrow();
    expect(() =>
      assertConfigForModes(configWith({ new_base_url: 'http://n' }), ['legacy_record']),
    ).toThrow(ConfigError);
  });

  it('requires only new for new_only_assert and replay_against_recording', () => {
    const cfg = configWith({ new_base_url: 'http://n' });
    expect(() => assertConfigForModes(cfg, ['new_only_assert'])).not.toThrow();
    expect(() => assertConfigForModes(cfg, ['replay_against_recording'])).not.toThrow();
  });

  it('requires fixture_dir for replay_against_recording', () => {
    try {
      assertConfigForModes(configWith({ new_base_url: 'http://n', fixture_dir: '' }), [
        'replay_against_recording',
      ]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems.some((p) => p.includes('fixture_dir'))).toBe(true);
    }
  });

  it('includes the production guard override flag with a safe default', () => {
    expect(defaultConfig().allow_production_guard_override).toBe(false);
  });

  it('reports every missing requirement together', () => {
    try {
      assertConfigForModes(configWith({}), ['compare_live']);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems).toHaveLength(2);
    }
  });

  it('passes when no modes need a missing URL', () => {
    expect(() => assertConfigForModes(configWith({ new_base_url: 'http://n' }), [])).not.toThrow();
  });
});

describe('assertProductionUrlGuard', () => {
  it('passes when no patterns are configured', () => {
    expect(() =>
      assertProductionUrlGuard(configWith({ production_url_patterns: [] })),
    ).not.toThrow();
  });

  it('passes when environment is production regardless of matching hosts', () => {
    expect(() =>
      assertProductionUrlGuard(
        configWith({
          environment: 'production',
          production_url_patterns: ['*.stridelabs.ai'],
          legacy_base_url: 'https://auth.stridelabs.ai',
        }),
      ),
    ).not.toThrow();
  });

  it('aborts when a base URL hostname matches a pattern outside production', () => {
    try {
      assertProductionUrlGuard(
        configWith({
          environment: 'local',
          production_url_patterns: ['*.stridelabs.ai'],
          new_base_url: 'https://auth.stridelabs.ai',
        }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('auth.stridelabs.ai');
      expect(message).toContain('*.stridelabs.ai');
    }
  });

  it('matches the glob against the hostname only, ignoring scheme/port/path', () => {
    expect(() =>
      assertProductionUrlGuard(
        configWith({
          environment: 'local',
          production_url_patterns: ['*.stridelabs.ai'],
          new_base_url: 'https://auth.stridelabs.ai:8443/some/path',
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('does not false-match an unrelated host', () => {
    expect(() =>
      assertProductionUrlGuard(
        configWith({
          environment: 'local',
          production_url_patterns: ['*.stridelabs.ai'],
          new_base_url: 'https://auth.notstridelabs.ai',
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertProductionUrlGuard(
        configWith({
          environment: 'local',
          production_url_patterns: ['*.stridelabs.ai'],
          new_base_url: 'http://localhost:3000',
        }),
      ),
    ).not.toThrow();
  });

  it('matches case-insensitively', () => {
    expect(() =>
      assertProductionUrlGuard(
        configWith({
          environment: 'local',
          production_url_patterns: ['*.STRIDELABS.ai'],
          new_base_url: 'https://Auth.StrideLabs.AI',
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('rejects empty pattern strings regardless of environment', () => {
    expect(() =>
      assertProductionUrlGuard(
        configWith({ environment: 'production', production_url_patterns: [''] }),
      ),
    ).toThrow(ConfigError);
    expect(() =>
      assertProductionUrlGuard(
        configWith({ environment: 'local', production_url_patterns: ['  '] }),
      ),
    ).toThrow(ConfigError);
  });

  it('fails closed with ConfigError when a base URL cannot be parsed, instead of silently skipping it', () => {
    try {
      assertProductionUrlGuard(
        configWith({
          environment: 'local',
          production_url_patterns: ['*.stridelabs.ai'],
          new_base_url: 'not a valid url',
        }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('not a valid url');
    }
  });

  it('does not fail closed on an unparseable URL when there are no patterns to guard against', () => {
    expect(() =>
      assertProductionUrlGuard(
        configWith({
          environment: 'local',
          production_url_patterns: [],
          new_base_url: 'not a url',
        }),
      ),
    ).not.toThrow();
  });

  it('strips IPv6 brackets so an unbracketed pattern matches an IPv6 base URL hostname', () => {
    expect(() =>
      assertProductionUrlGuard(
        configWith({
          environment: 'local',
          production_url_patterns: ['2001:db8::1'],
          new_base_url: 'https://[2001:db8::1]:8443/some/path',
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('matches an IPv6 wildcard glob against the bracket-stripped hostname', () => {
    expect(() =>
      assertProductionUrlGuard(
        configWith({
          environment: 'local',
          production_url_patterns: ['2001:db8::*'],
          new_base_url: 'https://[2001:db8::1]/',
        }),
      ),
    ).toThrow(ConfigError);
  });

  it('does not false-match an unrelated IPv6 host', () => {
    expect(() =>
      assertProductionUrlGuard(
        configWith({
          environment: 'local',
          production_url_patterns: ['2001:db8::1'],
          new_base_url: 'https://[::1]/',
        }),
      ),
    ).not.toThrow();
  });
});
