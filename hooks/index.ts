import { randomUUID } from 'node:crypto';
// This is Pharos's own repo, so its `hooks/index.ts` (used by the example
// scenarios and `bun run ftest`) imports the public barrel by relative path
// rather than the package name: there is no node_modules self-link for a
// standalone (non-workspace) package, so `tsc --noEmit` cannot resolve
// `import ... from 'pharos'` even though bun's own runtime resolver can
// (verified while building this barrel, spec Section 19.1). A **scaffolded
// target repo** installs Pharos as a real git dependency, so its
// `hooks/index.ts` (written by `pharos init`, Section 19.2) imports from the
// package name, `'pharos'`, not a relative path into this source tree.
import type { HookContext } from '../src/index';

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
