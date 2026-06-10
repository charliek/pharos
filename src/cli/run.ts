import type { Command } from 'commander';
import { notImplemented } from './util';

/** Register the `run` command. Execution lands in a later phase (spec Section 14). */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run scenarios and compare the new service against legacy')
    .option('-c, --config <path>', 'path to the pharos config file')
    .option('-s, --scenario <id>', 'run a single scenario by id')
    .option('--include-tag <tag...>', 'only run scenarios carrying these tags')
    .option('--exclude-tag <tag...>', 'skip scenarios carrying these tags')
    .action(() => notImplemented('run'));
}
