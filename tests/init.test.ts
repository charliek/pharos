import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config';
import { loadContractFile } from '../src/contract/load';
import { ConfigError } from '../src/errors';
import {
  DEFAULT_SERVICE,
  ScaffoldConflictError,
  scaffoldFiles,
  scaffoldProject,
} from '../src/scaffold';
import { validateProject } from '../src/validation';

/**
 * Spec Section 19.2 / 16: `pharos init` writes the documented file set, the
 * generated tree passes `validate` **unmodified**, and rerunning refuses to
 * overwrite. The validate check calls the library directly against the tmpdir
 * (with `cwd` pointed at it, the Section 19.3 resolution rule) rather than
 * spawning the CLI.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pharos-init-'));
});

function read(relative: string): string {
  return readFileSync(join(dir, relative), 'utf8');
}

/** Load the scaffolded config exactly as an invocation from that directory would. */
function loadScaffoldedConfig() {
  return loadConfig({ cwd: dir, env: {} });
}

describe('scaffoldProject — the init file set', () => {
  it('writes the documented files with the default service name', () => {
    const result = scaffoldProject({ dir });

    expect(result.service).toBe(DEFAULT_SERVICE);
    expect(result.overwritten).toEqual([]);
    expect(result.written).toEqual([
      'package.json',
      'pharos.config.json',
      `contracts/${DEFAULT_SERVICE}.contract.yaml`,
      'scenarios/smoke/health.yaml',
      'hooks/index.ts',
      '.gitignore',
      'README.md',
    ]);
    for (const file of result.written) {
      expect(read(file).length).toBeGreaterThan(0);
    }
  });

  it('pre-fills the config with the documented layout and redaction defaults', () => {
    scaffoldProject({ dir });
    const config = JSON.parse(read('pharos.config.json'));

    expect(config.scenario_dir).toBe('./scenarios');
    expect(config.contract_dir).toBe('./contracts');
    expect(config.fixture_dir).toBe('./fixtures/recordings');
    expect(config.report_dir).toBe('./reports');
    expect(config.hooks_module).toBe('./hooks/index.ts');
    expect(config.environment).toBe('local');
    expect(config.production_url_patterns).toEqual([]);
    // The floor that can exit the run 20 is scaffolded, not left implicit.
    expect(config.min_scenarios).toBe(1);
    expect(config.redaction.headers).toContain('authorization');
    // Safety toggles stay out of the generated file — see src/scaffold.ts.
    expect(config.allow_destructive_tests).toBeUndefined();
    expect(config.allow_production_guard_override).toBeUndefined();
  });

  it('generates a runnable package pinning pharos as a git dependency placeholder', () => {
    scaffoldProject({ dir, service: 'checkout' });
    const pkg = JSON.parse(read('package.json'));

    expect(pkg.name).toBe('checkout-conformance');
    expect(pkg.private).toBe(true);
    expect(pkg.scripts.conformance).toBe('pharos run');
    expect(pkg.scripts.validate).toBe('pharos validate');
    // Spec Section 19.1: a pinned git dependency, with an obvious marker that
    // the placeholder must be replaced.
    expect(pkg.dependencies.pharos).toMatch(/^github:charliek\/pharos#/);
    expect(pkg.dependencies.pharos).toContain('REPLACE_WITH_PINNED_COMMIT_SHA');
  });

  it("imports hook types from the 'pharos' package name, not a relative path", () => {
    scaffoldProject({ dir });
    const hooks = read('hooks/index.ts');

    expect(hooks).toContain("import type { HookContext } from 'pharos';");
    expect(hooks).not.toMatch(/from '\.\.?\//);
    expect(hooks).toContain('export const hooks');
  });

  it('ignores generated reports and opt-in recordings', () => {
    scaffoldProject({ dir });
    const gitignore = read('.gitignore');

    expect(gitignore).toContain('reports/');
    expect(gitignore).toContain('fixtures/recordings/');
  });

  it('documents the cwd rule, the safety model, and the follow_redirects pitfall', () => {
    scaffoldProject({ dir, service: 'checkout' });
    const readme = read('README.md');

    expect(readme).toContain('# checkout conformance suite');
    expect(readme).toContain('current working directory');
    expect(readme).toContain('follow_redirects');
    expect(readme).toContain('production_url_patterns');
    expect(readme).toContain('allowedEnvironments');
    expect(readme).toContain('pharos_spec.md');
  });
});

describe('scaffoldProject — the generated tree is valid unmodified', () => {
  it('passes validateProject with no changes', () => {
    scaffoldProject({ dir });
    const report = validateProject(loadScaffoldedConfig());

    expect(report.invalid).toBe(0);
    expect(report.results.map((result) => result.kind).sort()).toEqual(['contract', 'scenario']);
    expect(report.results.find((r) => r.kind === 'scenario')?.scenarioId).toBe('smoke.health');
  });

  it('produces a contract that check-contract accepts', () => {
    scaffoldProject({ dir, service: 'checkout' });
    const contract = loadContractFile(join(dir, 'contracts/checkout.contract.yaml'));

    expect(contract.service).toBe('checkout');
    expect(contract.routes).toHaveLength(1);
    expect(contract.routes[0]?.id).toBe('health');
    expect(contract.routes[0]?.match).toEqual({ methods: ['GET'], path_template: '/health' });
    expect(contract.defaults?.compare_status).toBe(true);
  });

  it('threads --service through the contract, the scenario, and the filename', () => {
    const result = scaffoldProject({ dir, service: 'checkout' });

    expect(result.written).toContain('contracts/checkout.contract.yaml');
    expect(read('contracts/checkout.contract.yaml')).toContain("service: 'checkout'");
    expect(read('scenarios/smoke/health.yaml')).toContain("service: 'checkout'");
    // The reference resolves relative to the scenario file's own directory.
    expect(read('scenarios/smoke/health.yaml')).toContain(
      'contract: "../../contracts/checkout.contract.yaml#health"',
    );

    const report = validateProject(loadScaffoldedConfig());
    expect(report.invalid).toBe(0);
  });

  it('rejects a service name that cannot be a filename or package name', () => {
    expect(() => scaffoldProject({ dir, service: '../evil' })).toThrow(ConfigError);
    expect(() => scaffoldProject({ dir, service: 'My Service' })).toThrow(/invalid service name/);
  });

  it('keeps a YAML-ambiguous service name a string', () => {
    // '123' is a valid slug but an unquoted YAML integer, and 'null'/'true' are
    // worse: they parse as null/boolean and the contract's `service` (a string)
    // would fail schema validation on a tree init just generated.
    for (const service of ['123', 'null', 'true']) {
      dir = mkdtempSync(join(tmpdir(), 'pharos-init-'));
      scaffoldProject({ dir, service });

      const contract = loadContractFile(join(dir, `contracts/${service}.contract.yaml`));
      expect(contract.service).toBe(service);
      expect(read(`contracts/${service}.contract.yaml`)).toContain(`service: '${service}'`);
      expect(validateProject(loadScaffoldedConfig()).invalid).toBe(0);
    }
  });
});

describe('scaffoldProject — idempotency', () => {
  it('refuses to overwrite and names every conflicting file', () => {
    scaffoldProject({ dir });

    let error: unknown;
    try {
      scaffoldProject({ dir });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ScaffoldConflictError);
    const conflict = error as ScaffoldConflictError;
    // The directories it created are not conflicts — only the files are.
    expect(conflict.conflicts.map((c) => c.path)).toEqual(scaffoldFiles().map((file) => file.path));
    expect(conflict.conflicts.every((c) => c.fatal)).toBe(false);
    expect(conflict.message).toContain('--force');
  });

  it('names only the colliding file and writes nothing when it refuses', () => {
    writeFileSync(join(dir, 'README.md'), 'hand-written\n', 'utf8');

    expect(() => scaffoldProject({ dir })).toThrow(ScaffoldConflictError);
    try {
      scaffoldProject({ dir });
    } catch (caught) {
      expect((caught as ScaffoldConflictError).conflicts).toEqual([
        { path: 'README.md', reason: 'already exists', fatal: false },
      ]);
    }
    // Aborted before any write: the untouched README survives and nothing else appeared.
    expect(read('README.md')).toBe('hand-written\n');
    expect(() => read('pharos.config.json')).toThrow();
  });

  it('scaffolds into an existing non-empty directory when nothing collides', () => {
    writeFileSync(join(dir, 'NOTES.md'), 'pre-existing\n', 'utf8');

    const result = scaffoldProject({ dir });

    expect(result.overwritten).toEqual([]);
    expect(read('NOTES.md')).toBe('pre-existing\n');
    expect(validateProject(loadScaffoldedConfig()).invalid).toBe(0);
  });

  it('overwrites with force and reports what it replaced', () => {
    scaffoldProject({ dir });
    writeFileSync(join(dir, 'README.md'), 'clobbered\n', 'utf8');

    const result = scaffoldProject({ dir, force: true });

    expect(result.overwritten).toEqual(result.written);
    expect(read('README.md')).toContain('conformance suite');
  });

  it('refuses when a directory it needs exists as a file, and writes nothing', () => {
    // `scenarios` as a *file* is invisible to a presence check on
    // `scenarios/smoke/health.yaml`, but mkdirSync would fail on it mid-write.
    writeFileSync(join(dir, 'scenarios'), 'not a directory\n', 'utf8');

    let error: unknown;
    try {
      scaffoldProject({ dir });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ScaffoldConflictError);
    expect((error as ScaffoldConflictError).conflicts).toEqual([
      {
        path: 'scenarios',
        reason: 'exists as a file, but the scaffold needs a directory here',
        fatal: true,
      },
    ]);
    // All-or-nothing: the earlier files in the set were not written either.
    expect(() => read('package.json')).toThrow();
    expect(() => read('pharos.config.json')).toThrow();
    // A type mismatch is not something --force may resolve.
    expect(() => scaffoldProject({ dir, force: true })).toThrow(ScaffoldConflictError);
    expect(read('scenarios')).toBe('not a directory\n');
  });

  it('refuses even with force when a generated file path exists as a directory', () => {
    mkdirSync(join(dir, 'README.md'));

    let error: unknown;
    try {
      scaffoldProject({ dir, force: true });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ScaffoldConflictError);
    const conflict = error as ScaffoldConflictError;
    expect(conflict.conflicts).toEqual([
      { path: 'README.md', reason: 'exists as a directory', fatal: true },
    ]);
    // The message must not suggest --force — the caller already used it.
    expect(conflict.message).not.toContain('--force');
    // writeFileSync would have thrown EISDIR partway through; nothing was written.
    expect(() => read('package.json')).toThrow();
  });

  it('refuses when the scaffold target itself is a file', () => {
    const target = join(dir, 'suite');
    writeFileSync(target, 'not a directory\n', 'utf8');

    expect(() => scaffoldProject({ dir: target, force: true })).toThrow(ScaffoldConflictError);
  });
});
