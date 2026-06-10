import { readFileSync } from 'node:fs';
import { parseDocument } from '../document';
import { validateWithSchema } from '../errors';
import { type Scenario, scenarioSchema } from './schema';

/** Validate an already-parsed value as a scenario, attributing errors to `file`. */
export function validateScenario(value: unknown, file: string): Scenario {
  return validateWithSchema(scenarioSchema, value, file);
}

/** Parse + validate scenario YAML/JSON text. */
export function loadScenarioFromText(text: string, file: string): Scenario {
  return validateScenario(parseDocument(text, file), file);
}

/** Load, parse, and validate a scenario file from disk. */
export function loadScenarioFile(file: string): Scenario {
  return loadScenarioFromText(readFileSync(file, 'utf8'), file);
}
