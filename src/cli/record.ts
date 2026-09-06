import type { Command } from 'commander';
import { type ConfigOverride, loadConfig } from '../config/config';
import { ConfigError, ValidationError } from '../errors';
import { runProject } from '../execution/run-all';
import { evaluateRunFloor } from '../reporting/report';
import { parseMinScenarios, printFileIssues, relativePath, writeStream } from './util';

interface RecordOptions {
  config?: string;
  scenario?: string;
  minScenarios?: string;
}

/**
 * Register the `record` command (spec Section 10.2). Runs legacy_record
 * scenarios with recording enabled, writing redacted fixtures. This is the
 * explicit opt-in that allows recordings to be written.
 *
 * `record` narrows the run to `legacy_record`, so it is exactly the command
 * that can quietly record nothing (a corpus with no `legacy_record` scenarios
 * used to print "0 recording(s) written" and exit 0). It prints the same
 * accounting `run` does and gates on the same {@link evaluateRunFloor} — but on
 * its own floor of at most 1 rather than the suite-wide `min_scenarios`, unless
 * `--min-scenarios` says otherwise; see the call site for the rule and its
 * reason.
 */
export function registerRecordCommand(program: Command): void {
  program
    .command('record')
    .description('Record legacy interactions into fixtures (explicit opt-in)')
    .option('-c, --config <path>', 'path to the pharos config file')
    .option('-s, --scenario <id>', 'record a single scenario by id')
    .option(
      '--min-scenarios <n>',
      "fail (exit 20) unless at least n scenarios record; overrides record's own floor",
    )
    .action(async (options: RecordOptions) => {
      try {
        const minScenarios = parseMinScenarios(options.minScenarios);
        const overrides: ConfigOverride | undefined =
          minScenarios === undefined ? undefined : { min_scenarios: minScenarios };
        const config = loadConfig({ configPath: options.config, overrides });
        // CI refuses recording updates by default (spec Section 10.2).
        if (config.output_mode === 'ci' && !config.allow_recording_updates) {
          process.stderr.write(
            'recording is refused in CI by default; set ALLOW_RECORDING_UPDATES=true to override\n',
          );
          process.exit(1);
        }
        const { results, accounting } = await runProject(config, {
          recordingEnabled: true,
          scenarioId: options.scenario,
          modes: ['legacy_record'],
        });

        let written = 0;
        let failed = 0;
        // Buffered rather than streamed: every result is already in hand here
        // (the run finished), and one awaited write per stream is what makes
        // the output survive `process.exit` on a pipe — see writeStream.
        const out: string[] = [];
        const err: string[] = [];
        for (const result of results) {
          for (const step of result.steps) {
            if (step.recordingPath) {
              written += 1;
              out.push(`recorded ${relativePath(step.recordingPath)}\n`);
            }
          }
          if (!result.pass) {
            failed += 1;
            err.push(`✗ ${result.scenarioId}: ${result.error ?? 'failed'}\n`);
          }
        }
        const filtered = accounting.filteredByMode + accounting.filteredByFilter;
        out.push(
          `\n${accounting.discovered} discovered · ${filtered} filtered · ` +
            `${accounting.executed} executed · ${written} recording(s) written; ` +
            `${failed} scenario(s) failed.\n`,
        );
        // THE RULE: `record`'s floor is `min(min_scenarios, 1)` — an explicit
        // `--min-scenarios <n>` wins outright, at whatever value it names.
        //
        // THE REASON: rule 3 (spec Section 11.5) applies the configured minimum
        // to a narrowed run so a renamed tag cannot silently shrink an
        // operator's filter. `record`'s narrowing is not an operator's filter,
        // it is the command's definition: it always runs
        // `modes: ['legacy_record']`, so every other scenario lands in
        // `filteredByMode` and can never be in `executed`. A hardcoded mode
        // filter cannot drift the way a tag can, so rule 3 buys nothing here
        // and costs everything: a repo gating CI at `min_scenarios: 20` would
        // get exit 20 from every `pharos record` forever, and the only escape
        // would be weakening the CI gate. Rules 1 (recorded nothing → 20) and 2
        // (a named `--scenario` must execute) still apply, and they are the
        // whole guard record needs.
        //
        // THE ESCAPE HATCH: this is a deliberate, documented exception rather
        // than a silent rewrite — an operator who does want a size assertion on
        // a recording run states it with `--min-scenarios <n>`, which is
        // honoured verbatim (`--min-scenarios 20` gates record at 20).
        const floor = evaluateRunFloor(accounting, {
          min_scenarios: minScenarios ?? Math.min(config.min_scenarios, 1),
        });
        if (!floor.met) err.push(`✗ run floor not met: ${floor.reason}\n`);
        await writeStream(process.stdout, out.join(''));
        await writeStream(process.stderr, err.join(''));
        // Precedence 20 > 1, as in `run`: a run that recorded nothing is
        // insufficient evidence, which makes any failure count incomplete.
        if (!floor.met) process.exit(20);
        process.exit(failed > 0 ? 1 : 0);
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
