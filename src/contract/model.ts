import { z } from 'zod';
import {
  comparisonBlockSchema,
  dimensionHeaderConflictMessage,
  dimensionHeaderConflicts,
} from '../comparison/rules';

/**
 * Zod schema and types for the shared behavioral contract (spec Section 5.2).
 * The schema is intentionally strict — unknown keys are rejected — so that
 * superseded dialects (e.g. camelCase `ignorePaths`) and typos fail at load
 * time with a field-level error rather than being silently ignored.
 */

export const httpMethodSchema = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD',
]);
export type HttpMethod = z.infer<typeof httpMethodSchema>;

export const contractRouteSchema = z
  .object({
    id: z.string().min(1),
    match: z
      .object({
        methods: z.array(httpMethodSchema).min(1),
        path_template: z.string().min(1),
      })
      .strict(),
    comparison: comparisonBlockSchema.optional(),
    expectations: z
      .object({
        typical_status: z.number().int().optional(),
        notes: z.string().optional(),
      })
      .strict()
      .optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export const contractSchema = z
  .object({
    version: z.literal(1),
    service: z.string().min(1),
    description: z.string().optional(),
    defaults: comparisonBlockSchema.optional(),
    routes: z.array(contractRouteSchema).min(1),
  })
  .strict()
  .superRefine((contract, ctx) => {
    const seen = new Set<string>();

    // `location` conflicts only with a `location` block, and the layers resolve
    // together — a defaults-level list entry conflicts with a route-level block
    // and vice versa (spec Section 8.6). `set-cookie` needs no such lookup: it is
    // rejected wherever it is listed.
    const locationBlockAnywhere =
      Boolean(contract.defaults?.location) ||
      contract.routes.some((route) => Boolean(route.comparison?.location));

    // A defaults-level entry is reported once at `defaults`, however many routes
    // it resolves into.
    const reportedInDefaults = new Set<string>();
    for (const name of dimensionHeaderConflicts(contract.defaults?.compare_headers, {
      location: locationBlockAnywhere,
    })) {
      const key = name.trim().toLowerCase();
      if (reportedInDefaults.has(key)) continue;
      reportedInDefaults.add(key);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaults', 'compare_headers'],
        message: dimensionHeaderConflictMessage(name),
      });
    }

    contract.routes.forEach((route, index) => {
      if (seen.has(route.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routes', index, 'id'],
          message: `duplicate route id '${route.id}'`,
        });
      }
      seen.add(route.id);

      for (const name of dimensionHeaderConflicts(route.comparison?.compare_headers, {
        location: Boolean(contract.defaults?.location ?? route.comparison?.location),
      })) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routes', index, 'comparison', 'compare_headers'],
          message: dimensionHeaderConflictMessage(name),
        });
      }
    });
  });

export type Contract = z.infer<typeof contractSchema>;
export type ContractRoute = z.infer<typeof contractRouteSchema>;
