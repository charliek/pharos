import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CustomComparator } from '../comparison/compare';
import type { HookRef } from '../scenarios/schema';
import { substituteValue } from './variables';

/**
 * The hook registry (spec Section 7.2). A scenario references hooks by name for
 * setup/cleanup and step before/after, custom comparators by name (compare.
 * comparator), and (future) custom normalizers. The registry is loaded once from
 * a configured module so scenarios stay declarative.
 */

export interface HookContext {
  scenarioId: string;
  /** The shared, mutable variable store — hooks may read and write it directly. */
  variables: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  /** Resolved upstream base URLs, so hooks can talk to the services for setup/cleanup. */
  legacyBaseUrl?: string;
  newBaseUrl?: string;
  /** Present for step-level (before/after) hooks. */
  stepId?: string;
}

// biome-ignore lint/suspicious/noConfusingVoidType: a hook may return a variable map or nothing
export type HookOutput = Record<string, unknown> | void;
export type HookFn = (ctx: HookContext, args?: unknown) => HookOutput | Promise<HookOutput>;
export type NormalizerFn = (value: unknown, args?: unknown) => unknown;

export class HookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookError';
  }
}

export interface LoadedRegistry {
  hooks: Record<string, HookFn>;
  comparators: Record<string, CustomComparator>;
  normalizers: Record<string, NormalizerFn>;
}

export function emptyRegistry(): LoadedRegistry {
  return { hooks: {}, comparators: {}, normalizers: {} };
}

/** Validate that an export is an object mapping names to functions. */
function validateFunctionMap(
  value: unknown,
  modulePath: string,
  exportName: string,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HookError(
      `${modulePath}: '${exportName}' export must be an object mapping names to functions`,
    );
  }
  for (const [name, fn] of Object.entries(value)) {
    if (typeof fn !== 'function') {
      throw new HookError(`${modulePath}: '${exportName}.${name}' is not a function`);
    }
  }
  return value as Record<string, unknown>;
}

/**
 * Load the hook registry from a module that exports `hooks`, `comparators`,
 * and/or `normalizers`. A missing module yields an empty registry (hooks are
 * optional). Exports are validated to be maps of functions. Comparators and
 * normalizers may have their own export or — following the spec's single-map
 * example — live among the `hooks`, so both authoring styles work.
 */
export async function loadHookRegistry(modulePath: string): Promise<LoadedRegistry> {
  if (!existsSync(modulePath)) return emptyRegistry();
  const moduleUrl = pathToFileURL(resolve(modulePath)).href;
  const loaded = (await import(moduleUrl)) as Record<string, unknown>;
  const hooks = validateFunctionMap(loaded.hooks, modulePath, 'hooks');
  const comparators = validateFunctionMap(loaded.comparators, modulePath, 'comparators');
  const normalizers = validateFunctionMap(loaded.normalizers, modulePath, 'normalizers');
  return {
    hooks: hooks as Record<string, HookFn>,
    comparators: { ...hooks, ...comparators } as Record<string, CustomComparator>,
    normalizers: { ...hooks, ...normalizers } as Record<string, NormalizerFn>,
  };
}

/**
 * Invoke a list of hook references in order. Args are variable-substituted before
 * the call; an `assign` mapping merges named keys of the hook's return value into
 * the scenario variables. An unknown hook name fails clearly.
 */
export async function runHooks(
  refs: HookRef[] | undefined,
  ctx: HookContext,
  hooks: Record<string, HookFn>,
): Promise<void> {
  if (!refs || refs.length === 0) return;
  for (const ref of refs) {
    const fn = hooks[ref.name];
    if (!fn) {
      const where = ctx.stepId ? ` (step '${ctx.stepId}')` : '';
      throw new HookError(`unknown hook '${ref.name}'${where}`);
    }
    const args = ref.args
      ? substituteValue(ref.args, { variables: ctx.variables, env: ctx.env })
      : undefined;
    const output = await fn(ctx, args);
    if (ref.assign) {
      if (!output || typeof output !== 'object') {
        throw new HookError(
          `hook '${ref.name}' has an 'assign' mapping but returned no output object`,
        );
      }
      for (const [variableName, outputKey] of Object.entries(ref.assign)) {
        if (!Object.hasOwn(output, outputKey)) {
          throw new HookError(
            `hook '${ref.name}' did not return key '${outputKey}' for assign → '${variableName}'`,
          );
        }
        ctx.variables[variableName] = (output as Record<string, unknown>)[outputKey];
      }
    }
  }
}
