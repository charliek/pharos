import { randomUUID } from 'node:crypto';
import type { HookContext } from '../src/execution/hooks';

/**
 * The example hook registry. Pharos loads this module (config.hooks_module) and
 * resolves hooks, custom comparators, and custom normalizers by name. Hooks
 * receive the scenario context (variables, env) and may return a map merged into
 * the variables via a scenario's `assign`.
 */

export const hooks = {
  /** Produce a unique, reviewable payload for the create-then-fetch flow. */
  generateUserPayload: (_ctx: HookContext) => ({
    email: `grace-${randomUUID().slice(0, 8)}@example.com`,
  }),

  /** Best-effort cleanup: delete the created user from both upstreams. */
  deleteUser: async (ctx: HookContext, args?: unknown): Promise<void> => {
    const userId = (args as { userId?: string } | undefined)?.userId;
    if (!userId) return;
    const bases = [
      ctx.legacyBaseUrl ?? ctx.env.LEGACY_BASE_URL,
      ctx.newBaseUrl ?? ctx.env.NEW_BASE_URL,
    ];
    for (const base of bases) {
      if (!base) continue;
      try {
        await fetch(`${base}/users/${userId}`, { method: 'DELETE' });
      } catch {
        // Cleanup is best-effort; a failure here must not mask the scenario result.
      }
    }
  },
};
