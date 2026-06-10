import { Command } from 'commander';
import { VERSION } from '../version';

/**
 * Placeholder action used while a subcommand is still a shell. Each command is
 * fleshed out in the phase that implements its feature (spec Section 14); until
 * then it exits non-zero with a clear message rather than pretending to work.
 */
function notImplemented(command: string): never {
  process.stderr.write(`pharos ${command}: not yet implemented\n`);
  process.exit(1);
}

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

  program
    .command('run')
    .description('Run scenarios and compare the new service against legacy')
    .option('-c, --config <path>', 'path to the pharos config file')
    .option('-s, --scenario <id>', 'run a single scenario by id')
    .option('--include-tag <tag...>', 'only run scenarios carrying these tags')
    .option('--exclude-tag <tag...>', 'skip scenarios carrying these tags')
    .action(() => notImplemented('run'));

  program
    .command('validate')
    .description('Validate scenarios and contracts without running them')
    .option('-c, --config <path>', 'path to the pharos config file')
    .action(() => notImplemented('validate'));

  program
    .command('record')
    .description('Record legacy interactions into fixtures (explicit opt-in)')
    .option('-c, --config <path>', 'path to the pharos config file')
    .option('-s, --scenario <id>', 'scenario to record')
    .action(() => notImplemented('record'));

  program
    .command('check-contract')
    .description('Validate a behavioral contract and its JSONPath compliance')
    .argument('<path>', 'path to the contract file')
    .action(() => notImplemented('check-contract'));

  return program;
}
