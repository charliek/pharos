import type { PharosConfig } from './config/config';
import { ContractRegistry } from './contract/load';
import { resolveScenarioContractRules } from './contract/resolve';
import { type FieldIssue, ValidationError } from './errors';
import { discoverFiles, discoverScenarioFiles } from './scenarios/discover';
import { loadScenarioFile } from './scenarios/load';

/**
 * Project-level validation orchestration behind the `validate` command. Kept out
 * of the CLI layer so it can be tested directly.
 */

/** Find contract files under `contractDir` (absolute, sorted). */
export function discoverContractFiles(contractDir: string): string[] {
  return discoverFiles(contractDir);
}

export type FileKind = 'scenario' | 'contract';

export interface FileValidation {
  file: string;
  kind: FileKind;
  ok: boolean;
  issues: FieldIssue[];
  scenarioId?: string;
}

export interface ValidationReport {
  results: FileValidation[];
  valid: number;
  invalid: number;
}

function toFailure(file: string, kind: FileKind, error: unknown): FileValidation {
  if (error instanceof ValidationError) {
    return { file: error.file, kind, ok: false, issues: error.issues };
  }
  return {
    file,
    kind,
    ok: false,
    issues: [{ path: '(error)', message: error instanceof Error ? error.message : String(error) }],
  };
}

/**
 * Validate every contract and scenario reachable from the configured directories.
 * Scenarios that reference a contract also have the reference resolved (file,
 * route id) so a dangling reference is caught here, not at run time.
 */
export function validateProject(config: PharosConfig): ValidationReport {
  const results: FileValidation[] = [];
  const registry = new ContractRegistry();

  for (const file of discoverContractFiles(config.contract_dir)) {
    try {
      registry.load(file);
      results.push({ file, kind: 'contract', ok: true, issues: [] });
    } catch (error) {
      results.push(toFailure(file, 'contract', error));
    }
  }

  for (const file of discoverScenarioFiles(config.scenario_dir)) {
    try {
      const scenario = loadScenarioFile(file);
      if (scenario.contract) {
        resolveScenarioContractRules(scenario, file, registry);
      }
      results.push({ file, kind: 'scenario', ok: true, issues: [], scenarioId: scenario.id });
    } catch (error) {
      results.push(toFailure(file, 'scenario', error));
    }
  }

  const invalid = results.filter((result) => !result.ok).length;
  return { results, valid: results.length - invalid, invalid };
}
