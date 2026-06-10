import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  emptyRegistry,
  type HookContext,
  HookError,
  loadHookRegistry,
  runHooks,
} from '../src/execution/hooks';

const here = dirname(fileURLToPath(import.meta.url));

describe('loadHookRegistry', () => {
  it('loads hooks and comparators from a module', async () => {
    const registry = await loadHookRegistry(resolve(here, 'fixtures/hooks/registry.ts'));
    expect(typeof registry.hooks.makeUser).toBe('function');
    expect(typeof registry.comparators.alwaysPass).toBe('function');
  });

  it('returns an empty registry for a missing module', async () => {
    const registry = await loadHookRegistry(resolve(here, 'fixtures/hooks/does-not-exist.ts'));
    expect(registry).toEqual(emptyRegistry());
  });
});

describe('runHooks', () => {
  function ctx(): HookContext {
    return { scenarioId: 's', variables: {}, env: {} as NodeJS.ProcessEnv };
  }

  it('merges assigned output keys into scenario variables', async () => {
    const context = ctx();
    await runHooks([{ name: 'gen', assign: { userId: 'id' } }], context, {
      gen: () => ({ id: 'u9' }),
    });
    expect(context.variables.userId).toBe('u9');
  });

  it('substitutes args and lets a hook mutate variables directly', async () => {
    const context = ctx();
    context.variables.base = 'b';
    await runHooks([{ name: 'set', args: { v: '{{ variables.base }}' } }], context, {
      set: (hookCtx, args) => {
        hookCtx.variables.copied = (args as { v: string }).v;
      },
    });
    expect(context.variables.copied).toBe('b');
  });

  it('awaits async hooks', async () => {
    const context = ctx();
    await runHooks([{ name: 'a', assign: { x: 'x' } }], context, {
      a: async () => ({ x: 'done' }),
    });
    expect(context.variables.x).toBe('done');
  });

  it('fails clearly on an unknown hook', async () => {
    await expect(runHooks([{ name: 'missing' }], ctx(), {})).rejects.toBeInstanceOf(HookError);
  });

  it('throws when assign is set but the hook returns nothing', async () => {
    await expect(
      runHooks([{ name: 'noop', assign: { x: 'id' } }], ctx(), { noop: () => {} }),
    ).rejects.toBeInstanceOf(HookError);
  });

  it('throws when assign references a key the hook did not return', async () => {
    await expect(
      runHooks([{ name: 'gen', assign: { x: 'missing' } }], ctx(), { gen: () => ({ id: '1' }) }),
    ).rejects.toThrow(/missing/);
  });
});
