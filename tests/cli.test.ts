import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProgram } from '../src/cli/program';
import { replyJson, startTestServer, type TestServer } from './helpers/server';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

describe('cli program', () => {
  it('exposes the MVP subcommands', () => {
    const program = buildProgram();
    const names = program.commands.map((command) => command.name()).sort();
    expect(names).toEqual(['check-contract', 'init', 'record', 'run', 'validate']);
  });

  it('reports its version', () => {
    const program = buildProgram();
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

/**
 * The exit code a CI job actually observes. Everything else in this suite calls
 * the library directly, which cannot catch a wiring mistake between
 * `exitCodeFor` and `process.exit` — and an unmet floor that exits 0 anyway is
 * precisely the false green pharos#12 is about.
 */
describe('the real process exit code (subprocess)', () => {
  let server: TestServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  function writeConfig(overrides: Record<string, unknown>): {
    config: string;
    reportDir: string;
    fixtureDir: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), 'pharos-cli-'));
    const reportDir = join(dir, 'reports');
    // Never the default './fixtures/recordings': `record` writes there, and the
    // default resolves against the repo root this subprocess runs in.
    const fixtureDir = join(dir, 'fixtures');
    const config = join(dir, 'pharos.config.json');
    writeFileSync(
      config,
      JSON.stringify(
        {
          report_dir: reportDir,
          fixture_dir: fixtureDir,
          contract_dir: resolve(here, 'fixtures/run'),
          hooks_module: resolve(here, 'fixtures/run/no-hooks.ts'),
          ...overrides,
        },
        null,
        2,
      ),
    );
    return { config, reportDir, fixtureDir };
  }

  /**
   * Config comes from the file alone: an inherited PHAROS_* / *_DIR variable
   * would silently retarget the run.
   */
  function cliEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    for (const key of [
      'MIN_SCENARIOS',
      'SCENARIO_DIR',
      'CONTRACT_DIR',
      'REPORT_DIR',
      'FIXTURE_DIR',
      'PHAROS_MODE',
      'PHAROS_ENVIRONMENT',
      'ALLOW_DESTRUCTIVE_TESTS',
      'ALLOW_RECORDING_UPDATES',
      'ALLOW_PRODUCTION_GUARD_OVERRIDE',
    ]) {
      delete env[key];
    }
    return env;
  }

  function runCli(args: string[]) {
    return spawnSync('bun', ['run', 'src/cli/index.ts', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: cliEnv(),
    });
  }

  /**
   * The async twin of {@link runCli}. `spawnSync` blocks this process's event
   * loop, so a test whose CLI subprocess has to reach a server started *here*
   * would deadlock — the server could never answer.
   */
  function runCliAsync(
    args: string[],
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve_, reject) => {
      const child = spawn('bun', ['run', 'src/cli/index.ts', ...args], {
        cwd: repoRoot,
        env: cliEnv(),
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (status) => resolve_({ status, stdout, stderr }));
    });
  }

  it('exits 20 and still writes the reports when a run executes nothing', () => {
    const { config, reportDir } = writeConfig({
      scenario_dir: resolve(here, 'fixtures/run-floor/empty-dir'),
    });
    const proc = runCli(['run', '-c', config]);

    expect(proc.status).toBe(20);
    expect(`${proc.stdout}${proc.stderr}`).toContain('run floor not met');
    expect(`${proc.stdout}${proc.stderr}`).toContain('empty-dir');
    // The reports are still written: a floor failure is a verdict about the
    // run, not a crash, and CI has to be able to read it.
    const reportPath = join(reportDir, 'report.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    expect(report.summary.discovered).toBe(0);
    expect(report.summary.executed).toBe(0);
    expect(report.summary.floor.met).toBe(false);
    expect(existsSync(join(reportDir, 'junit.xml'))).toBe(true);
  });

  it('measures the floor on execution, not on outcome', () => {
    const { config } = writeConfig({
      scenario_dir: resolve(here, 'fixtures/run-floor/empty-dir'),
      min_scenarios: 0,
    });
    // Even the opt-out cannot make an empty run green…
    expect(runCli(['run', '-c', config]).status).toBe(20);

    // …while a run that executes a scenario needs no floor argument at all.
    const green = writeConfig({
      scenario_dir: resolve(here, 'fixtures/run-floor/single/scenarios'),
      legacy_base_url: 'http://127.0.0.1:1',
      new_base_url: 'http://127.0.0.1:1',
      // The scenario cannot reach those URLs, so it fails (exit 1) — but it
      // *executed*, which is what the floor measures.
    });
    expect(runCli(['run', '-c', green.config]).status).toBe(1);
  });

  it('exits 20 from `record` when the corpus has no legacy_record scenarios', () => {
    const { config } = writeConfig({
      scenario_dir: resolve(here, 'fixtures/run/scenarios'),
    });
    const proc = runCli(['record', '-c', config]);

    expect(proc.status).toBe(20);
    expect(proc.stdout).toContain('2 discovered · 2 filtered · 0 executed');
    expect(proc.stderr).toContain('run floor not met');
  });

  it('keeps `record` green under a min_scenarios its own narrowing can never meet', async () => {
    // `record` always narrows to modes: ['legacy_record'], so every other
    // scenario is `filteredByMode` and can never be `executed`. Applying the
    // suite-wide floor to that set made `pharos record` exit 20 on every
    // invocation in a repo that gates CI with min_scenarios — with no
    // `--min-scenarios` flag on `record` to escape it.
    server = await startTestServer((_r, res) => replyJson(res, 200, { id: 1 }));
    const { config } = writeConfig({
      scenario_dir: resolve(here, 'fixtures/run-record/scenarios'),
      legacy_base_url: server.url,
      min_scenarios: 3,
    });
    const proc = await runCliAsync(['record', '-c', config]);

    expect(proc.stderr).not.toContain('run floor not met');
    expect(proc.status).toBe(0);
    expect(proc.stdout).toContain('4 discovered · 3 filtered · 1 executed');
    expect(proc.stdout).toContain('1 recording(s) written');
  });

  it('exits 20 and still writes the reports when --scenario resolves to nothing', () => {
    // The pre-fix path threw ConfigError → exit 1 *before any report was
    // written*, so a CI job publishing reports/junit.xml republished the
    // previous run's file: a stale green artifact on a red build.
    const { config, reportDir } = writeConfig({
      scenario_dir: resolve(here, 'fixtures/run/scenarios'),
    });
    const proc = runCli(['run', '-c', config, '--scenario', 'run.no-such-id']);

    expect(proc.status).toBe(20);
    expect(`${proc.stdout}${proc.stderr}`).toContain('run.no-such-id');
    expect(existsSync(join(reportDir, 'report.json'))).toBe(true);
    expect(existsSync(join(reportDir, 'junit.xml'))).toBe(true);
  });

  it('rejects a garbage --min-scenarios instead of silently defaulting', () => {
    const { config } = writeConfig({
      scenario_dir: resolve(here, 'fixtures/run/scenarios'),
    });
    const proc = runCli(['run', '-c', config, '--min-scenarios', 'abc']);
    expect(proc.status).toBe(1);
    expect(proc.stderr).toContain('--min-scenarios');
  });
});
