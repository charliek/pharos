import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseDocument } from '../document';
import { ValidationError, validateWithSchema } from '../errors';
import { type Contract, type ContractRoute, contractSchema } from './model';

/** Validate an already-parsed value as a contract, attributing errors to `file`. */
export function validateContract(value: unknown, file: string): Contract {
  return validateWithSchema(contractSchema, value, file);
}

export function loadContractFromText(text: string, file: string): Contract {
  return validateContract(parseDocument(text, file), file);
}

export function loadContractFile(file: string): Contract {
  return loadContractFromText(readFileSync(file, 'utf8'), file);
}

export interface ContractReference {
  /** Absolute path to the contract file. */
  file: string;
  routeId: string;
}

/**
 * Parse a scenario's `contract` reference (`path#routeId`), resolving the path
 * relative to the referencing file's directory. `fromFile` is attributed to any
 * resulting error so the message points at the scenario, not the contract.
 */
export function parseContractReference(ref: string, fromFile: string): ContractReference {
  const hashIndex = ref.indexOf('#');
  const pathPart = hashIndex >= 0 ? ref.slice(0, hashIndex) : '';
  const routeId = hashIndex >= 0 ? ref.slice(hashIndex + 1) : '';
  if (!pathPart || !routeId) {
    throw new ValidationError(fromFile, [
      {
        path: 'contract',
        message: `contract reference '${ref}' must be of the form 'path#routeId'`,
      },
    ]);
  }
  const baseDir = dirname(resolve(fromFile));
  const file = isAbsolute(pathPart) ? pathPart : resolve(baseDir, pathPart);
  return { file, routeId };
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

/**
 * Loads contracts with a per-instance cache, so resolving many scenarios that
 * reference the same contract parses it once. Mirrors how Limen loads contracts
 * once at startup rather than per request.
 */
export class ContractRegistry {
  private readonly cache = new Map<string, Contract>();

  load(file: string): Contract {
    const abs = resolve(file);
    const cached = this.cache.get(abs);
    if (cached) return cached;
    const contract = loadContractFile(abs);
    this.cache.set(abs, contract);
    return contract;
  }

  /**
   * Resolve a parsed reference to a concrete contract route. A missing file or
   * unknown route id is reported against `fromFile` (the referencing scenario);
   * an invalid contract surfaces as an error against the contract file itself.
   */
  resolveRoute(ref: ContractReference, fromFile: string): ContractRoute {
    let contract: Contract;
    try {
      contract = this.load(ref.file);
    } catch (error) {
      if (isFileNotFound(error)) {
        throw new ValidationError(fromFile, [
          { path: 'contract', message: `referenced contract file not found: ${ref.file}` },
        ]);
      }
      throw error;
    }
    const route = contract.routes.find((candidate) => candidate.id === ref.routeId);
    if (!route) {
      throw new ValidationError(fromFile, [
        {
          path: 'contract',
          message: `contract '${ref.file}' has no route '${ref.routeId}'`,
        },
      ]);
    }
    return route;
  }
}
