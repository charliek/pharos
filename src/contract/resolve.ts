import type { ComparisonRules } from '../comparison/rules';
import { ValidationError } from '../errors';
import type { Scenario } from '../scenarios/schema';
import { type ContractRegistry, parseContractReference } from './load';
import { mergeContractRoute } from './merge';

/**
 * Resolve a scenario's `contract` reference (spec Section 5.4) to the merged
 * comparison rules for the scenario. Validates that the reference parses, the
 * file and route exist, and the scenario's `service` matches the contract's
 * (spec Section 4.3). Errors are attributed to `scenarioFile`.
 *
 * Shared by `validate` (which discards the rules) and the runner (which uses
 * them), so both apply identical resolution semantics.
 */
export function resolveScenarioContractRules(
  scenario: Scenario,
  scenarioFile: string,
  registry: ContractRegistry,
): ComparisonRules {
  if (!scenario.contract) {
    throw new Error('resolveScenarioContractRules requires a scenario with a contract reference');
  }
  const ref = parseContractReference(scenario.contract, scenarioFile);
  const route = registry.resolveRoute(ref, scenarioFile);
  const contract = registry.load(ref.file);
  if (contract.service !== scenario.service) {
    throw new ValidationError(scenarioFile, [
      {
        path: 'service',
        message: `scenario service '${scenario.service}' does not match contract service '${contract.service}' (${ref.file})`,
      },
    ]);
  }
  return mergeContractRoute(contract, route);
}
