import { describe, expect, it } from 'vitest';
import type { ScenarioResult } from '../src/execution/runner';
import { renderConsoleReport } from '../src/reporting/console-reporter';
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
    );
    expect(report.summary).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 });
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
    );
    const text = renderConsoleReport(report);
    expect(text).toContain('✓ p');
    expect(text).toContain('✗ f');
    expect(text).toContain('DIFFLINE');
    expect(text).toContain('skipped: guarded');
    expect(text).toContain('1 passed, 1 failed, 1 skipped');
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
              comparison: { pass: false, summary: 'm', mismatches: [], diffText: 'a<b' },
            },
          ],
        }),
        result({ scenarioId: 'k', pass: true, skipped: true, skipReason: 'g' }),
      ],
      startedAt,
      finishedAt,
    );
    const xml = renderJunitXml(report);
    expect(xml.startsWith('<?xml')).toBe(true);
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('f&lt;&amp;&gt;');
    expect(xml).toContain('a&lt;b');
    expect(xml).toContain('<skipped');
  });
});
