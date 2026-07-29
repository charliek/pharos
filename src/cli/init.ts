import type { Command } from 'commander';
import { ConfigError } from '../errors';
import { DEFAULT_SERVICE, ScaffoldConflictError, scaffoldProject } from '../scaffold';
import { relativePath } from './util';

interface InitOptions {
  service: string;
  force?: boolean;
}

/**
 * Register the `init` command (spec Section 19.2). Scaffolds a runnable
 * conformance directory; the scaffolding itself lives in `src/scaffold.ts` so it
 * is testable without spawning a process.
 */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Scaffold a conformance directory (config, scenarios, contract, hooks)')
    .argument('[dir]', 'directory to scaffold into', '.')
    .option(
      '--service <name>',
      'service name used in the contract and example scenario',
      DEFAULT_SERVICE,
    )
    .option('--force', 'overwrite existing files instead of refusing')
    .action((dir: string, options: InitOptions) => {
      try {
        const result = scaffoldProject({ dir, service: options.service, force: options.force });
        for (const file of result.written) {
          const overwritten = result.overwritten.includes(file);
          process.stdout.write(`  ${overwritten ? 'overwrote' : 'created  '} ${file}\n`);
        }
        process.stdout.write(
          `\n✓ scaffolded ${result.written.length} file(s) for service ` +
            `'${result.service}' into ${relativePath(result.dir)}.\n` +
            '  Next: pin the pharos git dependency in package.json, `bun install`, ' +
            'then run `bun run validate` from that directory (see its README).\n',
        );
        process.exit(0);
      } catch (error) {
        if (error instanceof ScaffoldConflictError) {
          process.stderr.write(
            `✗ ${relativePath(error.dir)}: ${error.conflicts.length} path conflict(s):\n`,
          );
          for (const conflict of error.conflicts) {
            process.stderr.write(`    ${conflict.path} — ${conflict.reason}\n`);
          }
          // A type mismatch would need a delete to resolve, and `init` never
          // deletes anything the user put there.
          process.stderr.write(
            error.conflicts.some((conflict) => conflict.fatal)
              ? '  Nothing was written. Move or remove these paths by hand; --force cannot replace them.\n'
              : '  Nothing was written. Re-run with --force to overwrite.\n',
          );
          process.exit(1);
        }
        if (error instanceof ConfigError) {
          process.stderr.write(`${error.message}\n`);
          process.exit(1);
        }
        throw error;
      }
    });
}
