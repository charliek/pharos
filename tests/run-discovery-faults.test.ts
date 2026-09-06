import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, type PharosConfig } from '../src/config/config';
import { type RunProjectOptions, runProject } from '../src/execution/run-all';
import { buildReport, exitCodeFor } from '../src/reporting/report';

/**
 * Faults injected at the one boundary `run-all.ts` has to trust: discovery.
 * Neither case here is reachable from a fixture on disk — a miscounted
 * denominator needs a code path that drops a file without counting it, and the
 * discovery-time errnos need the directory to change *between* the stat and the
 * readdir — so discovery is mocked to produce exactly those two faults.
 */
const discovery = vi.hoisted(() => ({
  /**
   * Files discovery *claims* beyond the ones it hands back. `+1` is a file that
   * reached no classification (a future unaccounted `continue`); `-1` is a file
   * classified twice.
   */
  phantom: 0,
  /** An errno to raise from discovery instead of returning files. */
  errno: undefined as string | undefined,
}));

vi.mock('../src/scenarios/discover', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/scenarios/discover')>();
  return {
    ...actual,
    discoverScenarioFiles: (dir: string, patterns?: string[]): string[] => {
      if (discovery.errno !== undefined) {
        const error: NodeJS.ErrnoException = new Error(
          `${discovery.errno}: injected by the test, scandir '${dir}'`,
        );
        error.code = discovery.errno;
        throw error;
      }
      const files = actual.discoverScenarioFiles(dir, patterns);
      if (discovery.phantom === 0) return files;
      // Reports a different count than it yields. An array cannot lie about its
      // own length, so this is a hand-rolled iterable — `runProject` reads
      // `.length` for the denominator and iterates for the classifications.
      return {
        length: files.length + discovery.phantom,
        [Symbol.iterator]: () => files[Symbol.iterator](),
      } as unknown as string[];
    },
  };
});

const here = dirname(fileURLToPath(import.meta.url));
const scenarioDir = resolve(here, 'fixtures/run/scenarios');

beforeEach(() => {
  discovery.phantom = 0;
  discovery.errno = undefined;
});

function config(overrides: Partial<PharosConfig> = {}): PharosConfig {
  return {
    ...defaultConfig(),
    scenario_dir: scenarioDir,
    hooks_module: resolve(here, 'fixtures/run/no-hooks.ts'), // does not exist → empty registry
    ...overrides,
  };
}

/** `record`'s exact call into the pipeline: the mode filter is its definition. */
const recordOptions: RunProjectOptions = { modes: ['legacy_record'], recordingEnabled: true };

describe('the accounting invariant on record’s path', () => {
  it('accepts the real accounting of a record run', async () => {
    const { results, accounting } = await runProject(config(), recordOptions);
    expect(accounting).toMatchObject({ discovered: 2, filteredByMode: 2, executed: 0 });
    expect(results).toHaveLength(0);
  });

  it('throws inside runProject when a discovered file reaches no classification', async () => {
    // `record` never builds a report, so an invariant that only ran in
    // `buildReport` could not see this — and `record` is the only command that
    // supplies a mode filter, so a `filteredByMode` that stopped being counted
    // would be invisible exactly here.
    discovery.phantom = 1;
    await expect(runProject(config(), recordOptions)).rejects.toThrow(
      /accounting invariant violated — this is a tool bug/,
    );
  });

  it('throws inside runProject when a discovered file is classified twice', async () => {
    discovery.phantom = -1;
    await expect(runProject(config(), recordOptions)).rejects.toThrow(
      /1 scenario file\(s\) discovered but 2 classified .*filteredByMode 2/,
    );
  });
});

/**
 * A directory can change under the run between the stat and the readdir. Every
 * such outcome is "the harness could not read the suite" — a floor outcome with
 * a named reason (exit 20, reports written), never a raw errno and exit 1.
 */
describe('errors raised during discovery', () => {
  async function report(options: RunProjectOptions = {}) {
    const cfg = config();
    const { results, accounting } = await runProject(cfg, options);
    return buildReport(results, '2024-01-01T00:00:00Z', '2024-01-01T00:00:01Z', accounting, cfg);
  }

  it('treats a directory removed after the stat as missing, not as a crash', async () => {
    discovery.errno = 'ENOENT';
    const run = await report();
    expect(exitCodeFor(run)).toBe(20);
    expect(run.summary.floor.reason).toContain(scenarioDir);
    expect(run.summary.floor.reason).toContain('does not exist');
  });

  it('treats a directory replaced by a file after the stat as not-a-directory', async () => {
    discovery.errno = 'ENOTDIR';
    const run = await report();
    expect(exitCodeFor(run)).toBe(20);
    expect(run.summary.floor.reason).toContain('is not a directory');
  });

  it('still raises an unexpected errno loudly', async () => {
    // The catch stays narrow: EMFILE is not a statement about the operator's
    // directory, and swallowing it would report an empty suite as a floor
    // failure while hiding an exhausted resource.
    discovery.errno = 'EMFILE';
    await expect(runProject(config(), {})).rejects.toThrow(/EMFILE/);
  });
});
