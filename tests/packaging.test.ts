import { describe, expect, it } from 'vitest';
import * as pharos from '../src/index';

/**
 * Proves the public barrel (spec Section 19.1) exports what it promises. The
 * real compile-time check is `tsc --noEmit` picking up type errors in this
 * file (and in `hooks/index.ts` / `hooks/auth.ts`, which import from the same
 * barrel) if a type export is ever dropped or reshaped incompatibly — the
 * `satisfies`/annotation checks below exist to fail that way, not to assert
 * interesting runtime behavior. This file does **not** cover `package.json`
 * `exports`/`types`/`files` or resolving the package by name (`'pharos'`
 * rather than a relative path) — those only mean something from *outside*
 * this repo. S2 (slauth consuming pharos as a real git dependency) is the
 * end-to-end proof that external `bun add`/git-dependency consumption works;
 * this test only guards the barrel's own export surface from regressing.
 */

describe('public barrel (src/index.ts)', () => {
  it('exports the hook registry value + type surface', async () => {
    expect(typeof pharos.HookError).toBe('function');
    // A HookError is a real Error subclass, not a plain object shape.
    expect(new pharos.HookError('boom')).toBeInstanceOf(Error);

    const ctx = {
      scenarioId: 'packaging.smoke',
      variables: {},
      env: {} as NodeJS.ProcessEnv,
    } satisfies pharos.HookContext;
    const hookFn: pharos.HookFn = (_ctx, _args): pharos.HookOutput => ({ ok: true });
    expect(await hookFn(ctx)).toEqual({ ok: true });

    const normalizer: pharos.NormalizerFn = (value) => value;
    expect(normalizer('x')).toBe('x');
  });

  it('exports the config value + type surface', () => {
    expect(typeof pharos.defaultConfig).toBe('function');
    expect(typeof pharos.loadConfig).toBe('function');
    const config: pharos.PharosConfig = pharos.defaultConfig();
    expect(config.scenario_dir).toBe('./scenarios');
    expect(config.hooks_module).toBe('./hooks/index.ts');

    const override: pharos.ConfigOverride = { legacy_base_url: 'http://legacy' };
    const redaction: pharos.RedactionTargets = config.redaction;
    const loadOptions: pharos.LoadConfigOptions = { overrides: override };
    expect(pharos.loadConfig(loadOptions).legacy_base_url).toBe('http://legacy');
    expect(redaction.headers).toContain('authorization');
  });

  it('exports the scenario schema + type surface', () => {
    expect(pharos.SCENARIO_MODES).toContain('new_only_assert');
    expect(pharos.COMPARE_STRATEGIES).toContain('explicit_expectations');
    expect(pharos.REQUEST_METHODS).toContain('GET');
    expect(pharos.modeSchema.safeParse('new_only_assert').success).toBe(true);
    expect(pharos.modeSchema.safeParse('not_a_mode').success).toBe(false);
    expect(pharos.strategySchema.safeParse('explicit_expectations').success).toBe(true);
    expect(pharos.strategySchema.safeParse('not_a_strategy').success).toBe(false);

    const parsed = pharos.scenarioSchema.parse({
      version: 1,
      id: 'packaging.smoke',
      name: 'Packaging smoke',
      service: 'example',
      tags: ['smoke'],
      mode: 'new_only_assert',
      steps: [
        {
          id: 'get',
          request: { method: 'GET', path: '/health' },
          compare: { strategy: 'explicit_expectations', expect: { status: 200 } },
        },
      ],
    });
    const scenario: pharos.Scenario = parsed;
    const step: pharos.ScenarioStep = scenario.steps[0] as pharos.ScenarioStep;
    const request: pharos.ScenarioRequest = step.request;
    const compare: pharos.ScenarioCompare | undefined = step.compare;
    const mode: pharos.ScenarioMode = scenario.mode;
    const method: pharos.RequestMethod = request.method;
    const strategy: pharos.CompareStrategy | undefined = compare?.strategy;
    const extract: pharos.ExtractRule = { from: 'response.body', path: '$.id' };
    const ref: pharos.HookRef = { name: 'someHook' };
    const safety: pharos.ScenarioSafety = { destructive: false };

    expect(mode).toBe('new_only_assert');
    expect(method).toBe('GET');
    expect(strategy).toBe('explicit_expectations');
    expect(extract.from).toBe('response.body');
    expect(ref.name).toBe('someHook');
    expect(safety.destructive).toBe(false);
  });

  it('exports the contract schema + type surface', () => {
    const parsed = pharos.contractSchema.parse({
      version: 1,
      service: 'example',
      routes: [
        {
          id: 'health',
          match: { methods: ['GET'], path_template: '/health' },
        },
      ],
    });
    const contract: pharos.Contract = parsed;
    const route: pharos.ContractRoute = contract.routes[0] as pharos.ContractRoute;
    const method: pharos.HttpMethod = route.match.methods[0] as pharos.HttpMethod;

    expect(route.id).toBe('health');
    expect(method).toBe('GET');
    expect(pharos.httpMethodSchema.safeParse('GET').success).toBe(true);
    expect(pharos.httpMethodSchema.safeParse('NOT_A_METHOD').success).toBe(false);
    expect(pharos.contractRouteSchema.safeParse(route).success).toBe(true);
  });
});
