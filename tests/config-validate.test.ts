import { describe, expect, it } from 'vitest';
import { defaultConfig, type PharosConfig } from '../src/config/config';
import { assertConfigForModes } from '../src/config/validate';
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
