import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import { loadContractFile } from '../contract/load';
import { ValidationError } from '../errors';
import { printFileIssues, relativePath } from './util';

/**
 * Register the `check-contract` command (spec Section 5.5). A successful load
 * means the schema is satisfied and every JSONPath is within the supported
 * subset — the same verdict Limen's `check-contract` produces.
 */
export function registerCheckContractCommand(program: Command): void {
  program
    .command('check-contract')
    .description('Validate a behavioral contract and its JSONPath compliance')
    .argument('<path>', 'path to the contract file')
    .action((path: string) => {
      if (!existsSync(path)) {
        process.stderr.write(`✗ ${relativePath(path)}: contract file not found\n`);
        process.exit(1);
      }
      try {
        const contract = loadContractFile(path);
        process.stdout.write(
          `✓ ${relativePath(path)} — valid contract for service '${contract.service}' ` +
            `(${contract.routes.length} route(s); all JSONPaths within the supported subset).\n`,
        );
        process.exit(0);
      } catch (error) {
        if (error instanceof ValidationError) {
          printFileIssues(error.file, error.issues);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`✗ ${relativePath(path)}: ${message}\n`);
        }
        process.exit(1);
      }
    });
}
