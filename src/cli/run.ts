import type { Command } from 'commander';
import { type ConfigOverride, loadConfig } from '../config/config';
import { ConfigError, ValidationError } from '../errors';
import { runProject } from '../execution/run-all';
import { renderConsoleReport } from '../reporting/console-reporter';
import { writeJsonReport } from '../reporting/json-reporter';
import { writeJunitReport } from '../reporting/junit-reporter';
import { buildReport, exitCodeFor } from '../reporting/report';
import { parseMinScenarios, printFileIssues, writeStream } from './util';

interface RunOptions {
  config?: string;
  scenario?: string;
  includeTag?: string[];
  excludeTag?: string[];
  minScenarios?: string;
}

/**
 * Register the `run` command (spec Sections 11 + 14 Phase 7). Discovers, filters,
 * and runs scenarios; prints a console report; writes the JSON and JUnit reports;
 * and exits non-zero when any required scenario fails (1) or the run's
 * scenario floor was not met (20, which takes precedence).
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run scenarios and compare the new service against legacy')
    .option('-c, --config <path>', 'path to the pharos config file')
    .option('-s, --scenario <id>', 'run a single scenario by id')
    .option('--include-tag <tag...>', 'only run scenarios carrying these tags')
    .option('--exclude-tag <tag...>', 'skip scenarios carrying these tags')
    .option('--min-scenarios <n>', 'fail (exit 20) unless at least n scenarios execute')
    .action(async (options: RunOptions) => {
      try {
        const minScenarios = parseMinScenarios(options.minScenarios);
        const overrides: ConfigOverride | undefined =
          minScenarios === undefined ? undefined : { min_scenarios: minScenarios };
        const config = loadConfig({ configPath: options.config, overrides });
        const startedAt = new Date().toISOString();
        const { results, accounting } = await runProject(config, {
          scenarioId: options.scenario,
          includeTags: options.includeTag,
          excludeTags: options.excludeTag,
        });
        const report = buildReport(
          results,
          startedAt,
          new Date().toISOString(),
          accounting,
          config,
        );
        // Awaited, not fire-and-forget: `process.exit` below truncates a
        // pending write on a pipe, and the summary line is the whole report an
        // operator reads in CI logs (see writeStream).
        await writeStream(process.stdout, renderConsoleReport(report));
        writeJsonReport(config.report_dir, report);
        writeJunitReport(config.report_dir, report);
        process.exit(exitCodeFor(report));
      } catch (error) {
        if (error instanceof ConfigError) {
          process.stderr.write(`${error.message}\n`);
          process.exit(1);
        }
        if (error instanceof ValidationError) {
          printFileIssues(error.file, error.issues);
          process.exit(1);
        }
        throw error;
      }
    });
}
