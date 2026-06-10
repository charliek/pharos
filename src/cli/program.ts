import { Command } from 'commander';
import { VERSION } from '../version';
import { registerCheckContractCommand } from './check-contract';
import { registerRecordCommand } from './record';
import { registerRunCommand } from './run';
import { registerValidateCommand } from './validate';

/**
 * Build the Pharos command-line program. Kept separate from the executable
 * entry point (`index.ts`) so tests can construct and inspect it without
 * triggering argument parsing or process exit.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('pharos')
    .description(
      'Black-box functional test suite for validating a new service against a legacy one',
    )
    .version(VERSION, '-v, --version', 'print the pharos version');

  registerRunCommand(program);
  registerValidateCommand(program);
  registerRecordCommand(program);
  registerCheckContractCommand(program);

  return program;
}
