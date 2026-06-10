import type { Command } from 'commander';
import { notImplemented } from './util';

/** Register the `record` command. Recording lands in a later phase (spec Section 14). */
export function registerRecordCommand(program: Command): void {
  program
    .command('record')
    .description('Record legacy interactions into fixtures (explicit opt-in)')
    .option('-c, --config <path>', 'path to the pharos config file')
    .option('-s, --scenario <id>', 'scenario to record')
    .action(() => notImplemented('record'));
}
