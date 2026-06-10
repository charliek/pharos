import { readFileSync } from 'node:fs';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { ValidationError } from './errors';

/**
 * Parse a document as YAML. YAML is a superset of JSON, so `.json` files parse
 * through the same path. Syntax errors are mapped to a file-addressed
 * {@link ValidationError} so the CLI can report the file (and line) cleanly.
 */
export function parseDocument(text: string, file: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    if (error instanceof YAMLParseError) {
      const pos = error.linePos?.[0];
      const where = pos ? ` (line ${pos.line}, column ${pos.col})` : '';
      throw new ValidationError(file, [
        { path: '(parse)', message: `YAML/JSON parse error${where}: ${error.message}` },
      ]);
    }
    throw error;
  }
}

/** Read and parse a YAML/JSON document from disk. */
export function readDocumentFile(file: string): unknown {
  return parseDocument(readFileSync(file, 'utf8'), file);
}
