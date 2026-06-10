import type { Command } from 'commander';
import { type ConfigOverride, loadConfig } from '../config/config';
import { type ValidationReport, validateProject } from '../validation';
import { printFileIssues } from './util';

interface ValidateOptions {
  config?: string;
  scenarioDir?: string;
  contractDir?: string;
}

/** Register the `validate` command (spec Section 16: validate scenarios + contracts). */
export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate scenarios and contracts without running them')
    .option('-c, --config <path>', 'path to the pharos config file')
    .option('--scenario-dir <path>', 'override the scenario directory')
    .option('--contract-dir <path>', 'override the contract directory')
    .action((options: ValidateOptions) => {
      const overrides: ConfigOverride = {};
      if (options.scenarioDir) overrides.scenario_dir = options.scenarioDir;
      if (options.contractDir) overrides.contract_dir = options.contractDir;

      const config = loadConfig({ configPath: options.config, overrides });
      const report = validateProject(config);
      printValidationReport(report);
      process.exit(report.invalid > 0 ? 1 : 0);
    });
}

function printValidationReport(report: ValidationReport): void {
  if (report.results.length === 0) {
    process.stdout.write('No scenarios or contracts found.\n');
    return;
  }
  for (const result of report.results) {
    if (!result.ok) printFileIssues(result.file, result.issues);
  }
  const validScenarios = report.results.filter((r) => r.ok && r.kind === 'scenario').length;
  const validContracts = report.results.filter((r) => r.ok && r.kind === 'contract').length;
  if (report.invalid === 0) {
    process.stdout.write(
      `✓ ${validScenarios} scenario(s) and ${validContracts} contract(s) valid.\n`,
    );
  } else {
    process.stderr.write(`\n${report.invalid} file(s) failed validation; ${report.valid} valid.\n`);
  }
}
