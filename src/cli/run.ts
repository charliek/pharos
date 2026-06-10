import type { Command } from 'commander';
import { loadConfig } from '../config/config';
import { ConfigError, ValidationError } from '../errors';
import { runProject } from '../execution/run-all';
import { printConsoleReport } from '../reporting/console-reporter';
import { writeJsonReport } from '../reporting/json-reporter';
import { writeJunitReport } from '../reporting/junit-reporter';
import { buildReport, exitCodeFor } from '../reporting/report';
import { printFileIssues } from './util';

interface RunOptions {
  config?: string;
  scenario?: string;
  includeTag?: string[];
  excludeTag?: string[];
}

/**
 * Register the `run` command (spec Sections 11 + 14 Phase 7). Discovers, filters,
 * and runs scenarios; prints a console report; writes the JSON and JUnit reports;
 * and exits non-zero when any required scenario fails.
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run scenarios and compare the new service against legacy')
    .option('-c, --config <path>', 'path to the pharos config file')
    .option('-s, --scenario <id>', 'run a single scenario by id')
    .option('--include-tag <tag...>', 'only run scenarios carrying these tags')
    .option('--exclude-tag <tag...>', 'skip scenarios carrying these tags')
    .action(async (options: RunOptions) => {
      try {
        const config = loadConfig({ configPath: options.config });
        const startedAt = new Date().toISOString();
        const results = await runProject(config, {
          scenarioId: options.scenario,
          includeTags: options.includeTag,
          excludeTags: options.excludeTag,
        });
        const report = buildReport(results, startedAt, new Date().toISOString());
        printConsoleReport(report);
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
