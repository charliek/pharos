import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunAccounting } from '../src/execution/run-all';
import type { ScenarioResult } from '../src/execution/runner';
import { renderConsoleReport } from '../src/reporting/console-reporter';
import { writeJsonReport } from '../src/reporting/json-reporter';
import { renderJunitXml } from '../src/reporting/junit-reporter';
import { buildReport, exitCodeFor } from '../src/reporting/report';

function result(over: Partial<ScenarioResult>): ScenarioResult {
  return {
    scenarioId: 'x',
    name: 'x',
    pass: true,
    skipped: false,
    steps: [],
    durationMs: 1,
    ...over,
  };
}

/** A counted accounting, as `runProject` returns one. */
function accounting(over: Partial<RunAccounting> = {}): RunAccounting {
  return {
    scenarioDir: '/scenarios',
    scenarioDirState: 'ok',
    discovered: 0,
    parseFailed: 0,
    filteredByMode: 0,
    filteredByFilter: 0,
    safetySkipped: 0,
    refused: 0,
    executed: 0,
    narrowed: [],
    gateReasons: [],
    ...over,
  };
}

const startedAt = '2024-01-01T00:00:00.000Z';
const finishedAt = '2024-01-01T00:00:01.000Z';

describe('buildReport', () => {
  it('summarizes passed, failed, and skipped', () => {
    const report = buildReport(
      [
        result({ scenarioId: 'a', pass: true }),
        result({ scenarioId: 'b', pass: false }),
        result({ scenarioId: 'c', pass: true, skipped: true, skipReason: 'destructive' }),
      ],
      startedAt,
      finishedAt,
      accounting({ discovered: 3, executed: 2, safetySkipped: 1 }),
    );
    expect(report.summary).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      discovered: 3,
      filtered: 0,
      parseFailed: 0,
      refused: 0,
      executed: 2,
      narrowed: [],
      floor: { minScenarios: 1, executed: 2, applied: 1, met: true },
    });
    expect(report.durationMs).toBe(1000);
    expect(exitCodeFor(report)).toBe(1);
  });

  it('omits raw legacy/new responses so secrets cannot leak', () => {
    const report = buildReport(
      [
        result({
          scenarioId: 'a',
          pass: false,
          steps: [
            {
              stepId: 's',
              pass: false,
              legacy: {
                status: 200,
                headers: { authorization: 'Bearer SECRET' },
                setCookie: [],
                bodyText: '{"token":"SECRET"}',
                bodyJson: { token: 'SECRET' },
                durationMs: 1,
              },
              candidate: {
                status: 200,
                headers: {},
                setCookie: [],
                bodyText: '{}',
                bodyJson: {},
                durationMs: 1,
              },
              comparison: {
                pass: false,
                summary: '1 mismatch (json_semantic)',
                mismatches: [
                  { path: '$.name', kind: 'value', expected: 'A', actual: 'B', message: 'differs' },
                ],
                diffText: '$.name: value differs (legacy: "A", new: "B")',
              },
            },
          ],
        }),
      ],
      startedAt,
      finishedAt,
      accounting({ discovered: 1, executed: 1 }),
    );
    expect(JSON.stringify(report)).not.toContain('SECRET');
  });
});

describe('renderConsoleReport', () => {
  it('marks pass, fail, and skip and prints a summary', () => {
    const report = buildReport(
      [
        result({ scenarioId: 'p', pass: true }),
        result({
          scenarioId: 'f',
          name: 'F',
          pass: false,
          steps: [
            {
              stepId: 's',
              pass: false,
              comparison: {
                pass: false,
                summary: '1 mismatch',
                mismatches: [],
                diffText: 'DIFFLINE',
              },
            },
          ],
        }),
        result({ scenarioId: 'k', pass: true, skipped: true, skipReason: 'guarded' }),
      ],
      startedAt,
      finishedAt,
      accounting({ discovered: 3, executed: 2, safetySkipped: 1 }),
    );
    const text = renderConsoleReport(report);
    expect(text).toContain('✓ p');
    expect(text).toContain('✗ f');
    expect(text).toContain('DIFFLINE');
    expect(text).toContain('skipped: guarded');
    expect(text).toContain('3 discovered · 2 executed · 1 passed · 1 failed · 1 skipped');
  });
});

describe('renderJunitXml', () => {
  it('produces escaped JUnit with failure and skipped cases', () => {
    const report = buildReport(
      [
        result({ scenarioId: 'p', pass: true }),
        result({
          scenarioId: 'f<&>',
          pass: false,
          steps: [
            {
              stepId: 's',
              pass: false,
              comparison: {
                pass: false,
                summary: 'm',
                mismatches: [],
                diffText: 'a<b',
                diffTruncated: true,
              },
            },
          ],
        }),
        result({ scenarioId: 'k', pass: true, skipped: true, skipReason: 'g' }),
      ],
      startedAt,
      finishedAt,
      accounting({ discovered: 3, executed: 2, safetySkipped: 1 }),
    );
    const xml = renderJunitXml(report);
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('f&lt;&amp;&gt;');
    expect(xml).toContain('a&lt;b');
    // A clipped mismatch list says so in CI, not only in the JSON report.
    expect(xml).toContain('more differences were truncated');
    expect(xml).toContain('<skipped');
  });
});

describe('the accounting invariant', () => {
  it('throws when a discovered file was dropped without being counted', () => {
    // Three files found, only two classified: the third fell through an
    // unaccounted `continue`. Counting (never deriving) each classification is
    // what makes this detectable at all.
    expect(() =>
      buildReport(
        [result({ scenarioId: 'a' }), result({ scenarioId: 'b' })],
        startedAt,
        finishedAt,
        accounting({ discovered: 3, executed: 2 }),
      ),
    ).toThrow(/accounting invariant violated — this is a tool bug/);
  });

  it('throws when the classifications and the reported results disagree', () => {
    expect(() =>
      buildReport(
        [result({ scenarioId: 'a' })],
        startedAt,
        finishedAt,
        accounting({ discovered: 2, executed: 1, safetySkipped: 1 }),
      ),
    ).toThrow(/accounting invariant violated/);
  });

  it('accepts a consistent accounting', () => {
    const report = buildReport(
      [result({ scenarioId: 'a' })],
      startedAt,
      finishedAt,
      accounting({ discovered: 3, executed: 1, filteredByFilter: 2 }),
    );
    expect(report.summary.discovered).toBe(3);
    expect(report.summary.filtered).toBe(2);
  });
});

describe('the run accounting in every reporter', () => {
  const mixed = [
    result({ scenarioId: 'parse-failure', pass: false, error: 'bad yaml' }),
    result({ scenarioId: 'skipped', skipped: true, skipReason: 'destructive' }),
    result({ scenarioId: 'refused', pass: false, error: 'refused' }),
    result({ scenarioId: 'ran', pass: true }),
  ];
  const mixedAccounting = accounting({
    discovered: 8,
    filteredByFilter: 4,
    parseFailed: 1,
    safetySkipped: 1,
    refused: 1,
    executed: 1,
    narrowed: ['--exclude-tag jwt'],
  });

  it('leads the console line with the denominator and names the narrowing', () => {
    const report = buildReport(mixed, startedAt, finishedAt, mixedAccounting);
    expect(renderConsoleReport(report)).toContain(
      '8 discovered · 1 executed · 1 passed · 2 failed · 1 skipped · ' +
        '4 filtered (--exclude-tag jwt) · parse-failed 1 · refused 1 (1000ms)',
    );
  });

  it('writes the accounting into the JSON report in camelCase', () => {
    const report = buildReport(mixed, startedAt, finishedAt, mixedAccounting);
    const dir = mkdtempSync(join(tmpdir(), 'pharos-json-report-'));
    const path = writeJsonReport(dir, report);
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    expect(parsed.summary).toMatchObject({
      discovered: 8,
      filtered: 4,
      parseFailed: 1,
      refused: 1,
      executed: 1,
      narrowed: ['--exclude-tag jwt'],
      floor: { minScenarios: 1, executed: 1, applied: 1, met: true },
    });
  });

  it('carries the accounting as JUnit testsuite properties', () => {
    const report = buildReport(mixed, startedAt, finishedAt, mixedAccounting);
    const xml = renderJunitXml(report);
    expect(xml).toContain('<property name="discovered" value="8"/>');
    expect(xml).toContain('<property name="executed" value="1"/>');
    expect(xml).toContain('<property name="filtered" value="4"/>');
    // Why the numerator is low, without opening the JSON report.
    expect(xml).toContain('<property name="parseFailed" value="1"/>');
    expect(xml).toContain('<property name="refused" value="1"/>');
    expect(xml).toContain('<property name="safetySkipped" value="1"/>');
    expect(xml).toContain('<property name="floor.minScenarios" value="1"/>');
    expect(xml).toContain('<property name="floor.applied" value="1"/>');
    expect(xml).toContain('<property name="narrowed" value="--exclude-tag jwt"/>');
  });
});

describe('an unmet floor in JUnit', () => {
  const report = buildReport(
    [result({ scenarioId: 'skipped', skipped: true, skipReason: 'destructive' })],
    startedAt,
    finishedAt,
    accounting({
      discovered: 2,
      filteredByFilter: 1,
      safetySkipped: 1,
      executed: 0,
      narrowed: ['--include-tag smoke'],
    }),
  );

  it('reports an error on both elements and counts the synthetic testcase', () => {
    const xml = renderJunitXml(report);
    // `tests` has to match the number of <testcase> elements, or CI's own
    // arithmetic disagrees with the file it is reading.
    expect(xml).toContain('<testsuites tests="2" failures="0" errors="1" skipped="1">');
    expect(xml).toContain(
      '<testsuite name="pharos [narrowed: --include-tag smoke]" tests="2" failures="0" errors="1" skipped="1"',
    );
    expect(xml).toContain('<testcase name="pharos.min_scenarios" classname="pharos"><error');
    expect(xml).toContain('no scenarios executed');
    expect(exitCodeFor(report)).toBe(20);
  });
});
