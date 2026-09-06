import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, type PharosConfig } from '../src/config/config';
import { type RunProjectOptions, runProject } from '../src/execution/run-all';
import { renderConsoleReport } from '../src/reporting/console-reporter';
import { renderJunitXml } from '../src/reporting/junit-reporter';
import { buildReport, exitCodeFor } from '../src/reporting/report';
import { replyJson, startTestServer, type TestServer } from './helpers/server';

const here = dirname(fileURLToPath(import.meta.url));
const scenarioDir = resolve(here, 'fixtures/run/scenarios');

let legacyServer: TestServer | undefined;
let newServer: TestServer | undefined;
let reportDir: string;

beforeEach(() => {
  reportDir = mkdtempSync(join(tmpdir(), 'pharos-run-'));
});
afterEach(async () => {
  await legacyServer?.close();
  await newServer?.close();
  legacyServer = undefined;
  newServer = undefined;
});

function config(overrides: Partial<PharosConfig> = {}): PharosConfig {
  return {
    ...defaultConfig(),
    scenario_dir: scenarioDir,
    legacy_base_url: legacyServer?.url,
    new_base_url: newServer?.url,
    report_dir: reportDir,
    hooks_module: resolve(here, 'fixtures/run/no-hooks.ts'), // does not exist → empty registry
    ...overrides,
  };
}

describe('runProject — the run pipeline', () => {
  it('runs reads and skips destructive scenarios without opt-in', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const { results, accounting } = await runProject(config(), {});
    const report = buildReport(
      results,
      '2024-01-01T00:00:00Z',
      '2024-01-01T00:00:00Z',
      accounting,
      config(),
    );
    expect(report.summary.total).toBe(2);
    expect(report.summary.passed).toBe(1);
    expect(report.summary.skipped).toBe(1);
    expect(report.summary.failed).toBe(0);
    // The denominator is what is on disk, not what survived the gates.
    expect(report.summary.discovered).toBe(2);
    expect(report.summary.executed).toBe(1);
    expect(exitCodeFor(report)).toBe(0);
    const destructive = report.scenarios.find((s) => s.scenarioId === 'run.destructive');
    expect(destructive?.skipped).toBe(true);
  });

  it('filters to a single scenario by id', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const { results } = await runProject(config(), { scenarioId: 'run.ok' });
    expect(results).toHaveLength(1);
    expect(results[0].scenarioId).toBe('run.ok');
  });

  it('filters by tag', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const included = await runProject(config(), { includeTags: ['smoke'] });
    expect(included.results.map((r) => r.scenarioId)).toEqual(['run.ok']);
    // Every discovered file lands in exactly one counted bucket — the one
    // filtered out is counted, never derived by subtraction (pharos#12).
    expect(included.accounting).toMatchObject({
      discovered: 2,
      parseFailed: 0,
      filteredByMode: 0,
      filteredByFilter: 1,
      safetySkipped: 0,
      refused: 0,
      executed: 1,
      narrowed: ['--include-tag smoke'],
    });
    const excluded = await runProject(config(), { excludeTags: ['destructive'] });
    expect(excluded.results.map((r) => r.scenarioId)).toEqual(['run.ok']);
  });

  it('reports a failure and yields a non-zero exit code', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: false }));
    const { results, accounting } = await runProject(config(), { scenarioId: 'run.ok' });
    const report = buildReport(
      results,
      '2024-01-01T00:00:00Z',
      '2024-01-01T00:00:00Z',
      accounting,
      config(),
    );
    expect(report.summary.failed).toBe(1);
    expect(exitCodeFor(report)).toBe(1);
  });

  it('runs destructive scenarios when opted in', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const { results } = await runProject(config({ allow_destructive_tests: true }), {
      scenarioId: 'run.destructive',
    });
    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(false);
    expect(results[0].pass).toBe(true);
  });

  it('skips a scenario requiring the production guard override unless overridden', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const guardDir = resolve(here, 'fixtures/run-guard/scenarios');
    const skipped = await runProject(
      config({ scenario_dir: guardDir, allow_destructive_tests: true }),
      {},
    );
    expect(skipped.results[0].skipped).toBe(true);
    expect(skipped.results[0].skipReason).toMatch(/production guard/);

    const allowed = await runProject(
      config({
        scenario_dir: guardDir,
        allow_destructive_tests: true,
        allow_production_guard_override: true,
      }),
      {},
    );
    expect(allowed.results[0].skipped).toBe(false);
    expect(allowed.results[0].pass).toBe(true);
  });

  /**
   * An unresolved `--scenario` is a **floor outcome (exit 20), not a
   * `ConfigError`**. It used to throw, which `cli/run.ts` turned into
   * `process.exit(1)` before writing any report — while the neighbouring case
   * (a named scenario a safety gate blocked) already exited 20 with both
   * reports on disk. Same operator mistake, two exit codes, and on the exit-1
   * path a CI job that publishes `reports/junit.xml` republishes the previous
   * run's file: a stale green artifact on a red build. The message text is
   * unchanged — it is the actionable part.
   */
  async function floorReport(cfg: PharosConfig, options: RunProjectOptions) {
    const { results, accounting } = await runProject(cfg, options);
    return buildReport(results, '2024-01-01T00:00:00Z', '2024-01-01T00:00:01Z', accounting, cfg);
  }

  it('exits 20 instead of silently reporting nothing when --scenario names an id that does not exist', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const run = await floorReport(config(), { scenarioId: 'run.does-not-exist' });
    expect(exitCodeFor(run)).toBe(20);
    expect(run.summary.executed).toBe(0);
    expect(run.summary.floor.reason).toContain('run.does-not-exist');
    expect(run.summary.floor.reason).toMatch(/did not match any scenario id/);
    // Fail-closed before any request work.
    expect(legacyServer.requests).toHaveLength(0);
    expect(newServer.requests).toHaveLength(0);
  });

  it('exits 20 instead of silently reporting nothing when a tag filter erases the named --scenario', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    // run.ok carries tag 'smoke'; excluding it erases the only scenario --scenario named.
    const run = await floorReport(config(), { scenarioId: 'run.ok', excludeTags: ['smoke'] });
    expect(exitCodeFor(run)).toBe(20);
    expect(run.summary.floor.reason).toContain('run.ok');
    expect(run.summary.floor.reason).toMatch(/filtered/);
    expect(legacyServer.requests).toHaveLength(0);
    expect(newServer.requests).toHaveLength(0);
  });

  it('mentions the parse failure when --scenario names a file that failed to parse', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const brokenDir = resolve(here, 'fixtures/run-parse-failure/scenarios');
    const run = await floorReport(config({ scenario_dir: brokenDir }), {
      scenarioId: 'run.broken',
    });
    // The parse failure is itself a failing result, so 20 has to outrank 1 here
    // too — otherwise the run reports "1 failed" and hides that nothing ran.
    expect(run.summary.failed).toBe(1);
    expect(exitCodeFor(run)).toBe(20);
    expect(run.summary.floor.reason).toContain('run.broken');
    expect(run.summary.floor.reason).toMatch(/parse/i);
    // Fail-closed before any request work, same as the other accounting-hole cases.
    expect(legacyServer.requests).toHaveLength(0);
    expect(newServer.requests).toHaveLength(0);
  });

  it('still runs normally when --scenario is named and no tag filter conflicts with it', async () => {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    const { results } = await runProject(config(), {
      scenarioId: 'run.ok',
      includeTags: ['smoke'],
    });
    expect(results).toHaveLength(1);
    expect(results[0].scenarioId).toBe('run.ok');
  });
});

/**
 * The run's scenario floor (spec Section 11.5, pharos#12). Every case here used
 * to exit 0: the denominator was whatever survived discovery and filtering, and
 * nothing compared it with what is on disk.
 */
describe('the run scenario floor', () => {
  const emptyDir = resolve(here, 'fixtures/run-floor/empty-dir');
  const missingDir = resolve(here, 'fixtures/run-floor/no-such-directory');
  const notADirectory = resolve(here, 'fixtures/run/scenarios/ok.yaml');
  const parseFailureDir = resolve(here, 'fixtures/run-floor/parse-failure/scenarios');
  const singleDir = resolve(here, 'fixtures/run-floor/single/scenarios');

  async function report(cfg: PharosConfig, options: RunProjectOptions = {}) {
    const { results, accounting } = await runProject(cfg, options);
    return buildReport(results, '2024-01-01T00:00:00Z', '2024-01-01T00:00:01Z', accounting, cfg);
  }

  async function startServers() {
    legacyServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
    newServer = await startTestServer((_r, res) => replyJson(res, 200, { ok: true }));
  }

  it('exits 20 naming an empty scenario_dir instead of reporting a clean zero', async () => {
    const run = await report(config({ scenario_dir: emptyDir }));
    expect(run.summary.discovered).toBe(0);
    expect(run.summary.executed).toBe(0);
    expect(exitCodeFor(run)).toBe(20);
    expect(run.summary.floor.reason).toContain(emptyDir);
    expect(run.summary.floor.reason).toContain('holds no *.yaml/*.yml/*.json');
  });

  it('exits 20 saying the scenario_dir does not exist when it is misspelled', async () => {
    const run = await report(config({ scenario_dir: missingDir }));
    expect(exitCodeFor(run)).toBe(20);
    expect(run.summary.floor.reason).toContain(missingDir);
    expect(run.summary.floor.reason).toContain('does not exist');
  });

  // Root reads a 0o000 directory regardless, so the case cannot be produced.
  it.skipIf(process.getuid?.() === 0)(
    'exits 20 saying the scenario_dir is not readable when the process cannot read it',
    async () => {
      // A container mounting the scenario volume with the wrong uid: fast-glob
      // raises a bare `EACCES: permission denied, scandir …`, which exited 1
      // with a stack trace and no report — the same "the harness could not read
      // the suite" class as a missing directory, which has always exited 20.
      const denied = mkdtempSync(join(tmpdir(), 'pharos-unreadable-'));
      chmodSync(denied, 0o000);
      try {
        const run = await report(config({ scenario_dir: denied }));
        expect(exitCodeFor(run)).toBe(20);
        expect(run.summary.floor.reason).toContain(denied);
        expect(run.summary.floor.reason).toContain('is not readable (permission denied)');
      } finally {
        chmodSync(denied, 0o700);
      }
    },
  );

  it('exits 20 saying the scenario_dir is not a directory when it names a file', async () => {
    const run = await report(config({ scenario_dir: notADirectory }));
    expect(exitCodeFor(run)).toBe(20);
    expect(run.summary.floor.reason).toContain('is not a directory');
  });

  // Root reads a 0o000 directory regardless, so the case cannot be produced.
  it.skipIf(process.getuid?.() === 0)(
    'says the scenario_dir is unreadable, not missing, when its parent cannot be read',
    async () => {
      // `existsSync` returns false for a directory behind an unreadable parent,
      // so the run used to report "does not exist" about a directory that does.
      // One `statSync` in a try/catch tells the two apart by errno.
      const parent = mkdtempSync(join(tmpdir(), 'pharos-closed-parent-'));
      const suite = join(parent, 'scenarios');
      mkdirSync(suite);
      chmodSync(parent, 0o000);
      try {
        const run = await report(config({ scenario_dir: suite }));
        expect(exitCodeFor(run)).toBe(20);
        expect(run.summary.floor.reason).toContain(suite);
        expect(run.summary.floor.reason).toContain('is not readable (permission denied)');
        expect(run.summary.floor.reason).not.toContain('does not exist');
      } finally {
        chmodSync(parent, 0o700);
      }
    },
  );

  it('exits 20 when a path component of the scenario_dir is a file (ENOTDIR)', async () => {
    // `existsSync` returns false here too, so this also used to read as "does
    // not exist"; the stat's errno names it. The same errno reaches the same
    // state when the directory is replaced by a file mid-run — see
    // tests/run-discovery-faults.test.ts.
    const run = await report(config({ scenario_dir: join(notADirectory, 'nested') }));
    expect(exitCodeFor(run)).toBe(20);
    expect(run.summary.floor.reason).toContain('is not a directory');
  });

  it('exits 20 naming the filter when a tag filter matches nothing', async () => {
    const run = await report(config(), { includeTags: ['no-such-tag'] });
    expect(exitCodeFor(run)).toBe(20);
    expect(run.summary.floor.reason).toContain('2 discovered');
    expect(run.summary.floor.reason).toContain('--include-tag no-such-tag');
  });

  it('does not count a safety-skipped scenario toward the floor', async () => {
    await startServers();
    const run = await report(config({ min_scenarios: 2 }));
    expect(run.summary.executed).toBe(1);
    expect(run.summary.skipped).toBe(1);
    expect(run.summary.floor.met).toBe(false);
    expect(exitCodeFor(run)).toBe(20);
  });

  it('does not count a parse failure toward the floor, and 20 outranks 1', async () => {
    await startServers();
    const run = await report(config({ scenario_dir: parseFailureDir, min_scenarios: 2 }));
    expect(run.summary.discovered).toBe(2);
    expect(run.summary.parseFailed).toBe(1);
    expect(run.summary.executed).toBe(1);
    // A parse failure is also a failing result: without the floor this run
    // would exit 1, and 20 has to win.
    expect(run.summary.failed).toBe(1);
    expect(exitCodeFor(run)).toBe(20);
  });

  it('does not count a production refusal toward the floor', async () => {
    const run = await report(config({ scenario_dir: singleDir, environment: 'production' }));
    expect(run.summary.refused).toBe(1);
    expect(run.summary.executed).toBe(0);
    expect(run.summary.failed).toBe(1);
    expect(exitCodeFor(run)).toBe(20);
    expect(run.summary.floor.reason).toContain('1 refused');
  });

  it('applies a floor of 1 to a --scenario run whatever min_scenarios says', async () => {
    await startServers();
    const run = await report(config({ min_scenarios: 5 }), { scenarioId: 'run.ok' });
    expect(run.summary.floor.minScenarios).toBe(5);
    expect(run.summary.floor.applied).toBe(1);
    expect(run.summary.floor.met).toBe(true);
    expect(exitCodeFor(run)).toBe(0);
  });

  it('fails a --scenario run whose named scenario a safety gate skipped, with the reason', async () => {
    const run = await report(config(), { scenarioId: 'run.destructive' });
    expect(run.summary.executed).toBe(0);
    expect(exitCodeFor(run)).toBe(20);
    expect(run.summary.floor.reason).toContain('run.destructive');
    expect(run.summary.floor.reason).toContain('ALLOW_DESTRUCTIVE_TESTS');
  });

  it('keeps the floor on a tag-narrowed run and shows the narrowing everywhere', async () => {
    await startServers();
    // The floor must EXCEED what the narrowed run can execute, or the case is
    // decoration: with `min_scenarios: 1` and one scenario executed it passes
    // whether the floor survived the narrowing or was reset to 1 — which is the
    // exact regression this test exists to forbid (`--include-tag` is the docs'
    // recommended CI gate, so a renamed tag must not quietly shrink the suite).
    const run = await report(config({ min_scenarios: 2 }), { includeTags: ['smoke'] });
    expect(run.summary.executed).toBe(1);
    expect(run.summary.floor.applied).toBe(2);
    expect(run.summary.floor.met).toBe(false);
    expect(exitCodeFor(run)).toBe(20);
    const console = renderConsoleReport(run);
    expect(console).toContain('2 discovered · 1 executed · 1 passed · 0 failed · 0 skipped');
    expect(console).toContain('1 filtered (--include-tag smoke)');
    // CI listings hide properties, so the narrowing is in the suite name too.
    expect(renderJunitXml(run)).toContain('name="pharos [narrowed: --include-tag smoke]"');

    // …and the floor is a floor, not a blanket refusal of narrowed runs: the
    // same narrowing under a floor it does meet is a clean 0.
    const met = await report(config({ min_scenarios: 1 }), { includeTags: ['smoke'] });
    expect(met.summary.floor.applied).toBe(1);
    expect(exitCodeFor(met)).toBe(0);
  });

  it('counts a mode filter separately from a tag filter', async () => {
    const run = await runProject(config(), { modes: ['legacy_record'] });
    expect(run.accounting).toMatchObject({
      discovered: 2,
      filteredByMode: 2,
      filteredByFilter: 0,
      executed: 0,
      narrowed: ['modes: legacy_record'],
    });
  });

  it('still exits 20 on an empty scenario_dir under min_scenarios: 0', async () => {
    // The opt-out is from the *minimum*, never from the zero-execution guard:
    // a run that executed nothing is not a pass at any floor.
    const run = await report(config({ scenario_dir: emptyDir, min_scenarios: 0 }));
    expect(run.summary.floor.minScenarios).toBe(0);
    expect(run.summary.floor.met).toBe(false);
    expect(exitCodeFor(run)).toBe(20);
    expect(run.summary.floor.reason).toContain(emptyDir);
  });
});
