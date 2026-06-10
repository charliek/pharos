import type { Command } from 'commander';
import { loadConfig } from '../config/config';
import { ConfigError } from '../errors';
import { runProject } from '../execution/run-all';
import { relativePath } from './util';

interface RecordOptions {
  config?: string;
  scenario?: string;
}

/**
 * Register the `record` command (spec Section 10.2). Runs legacy_record
 * scenarios with recording enabled, writing redacted fixtures. This is the
 * explicit opt-in that allows recordings to be written.
 */
export function registerRecordCommand(program: Command): void {
  program
    .command('record')
    .description('Record legacy interactions into fixtures (explicit opt-in)')
    .option('-c, --config <path>', 'path to the pharos config file')
    .option('-s, --scenario <id>', 'record a single scenario by id')
    .action(async (options: RecordOptions) => {
      const config = loadConfig({ configPath: options.config });
      // CI refuses recording updates by default (spec Section 10.2).
      if (config.output_mode === 'ci' && !config.allow_recording_updates) {
        process.stderr.write(
          'recording is refused in CI by default; set ALLOW_RECORDING_UPDATES=true to override\n',
        );
        process.exit(1);
      }
      try {
        const results = await runProject(config, {
          recordingEnabled: true,
          scenarioId: options.scenario,
          modes: ['legacy_record'],
        });

        let written = 0;
        let failed = 0;
        for (const result of results) {
          for (const step of result.steps) {
            if (step.recordingPath) {
              written += 1;
              process.stdout.write(`recorded ${relativePath(step.recordingPath)}\n`);
            }
          }
          if (!result.pass) {
            failed += 1;
            process.stderr.write(`✗ ${result.scenarioId}: ${result.error ?? 'failed'}\n`);
          }
        }
        process.stdout.write(`\n${written} recording(s) written; ${failed} scenario(s) failed.\n`);
        process.exit(failed > 0 ? 1 : 0);
      } catch (error) {
        if (error instanceof ConfigError) {
          process.stderr.write(`${error.message}\n`);
          process.exit(1);
        }
        throw error;
      }
    });
}
