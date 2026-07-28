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
    // A `set-cookie`/`location` conflict listed in service defaults is reported
    // once, however many routes declare the block that conflicts with it.
    const reportedInDefaults = new Set<string>();

    contract.routes.forEach((route, index) => {
      if (seen.has(route.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routes', index, 'id'],
          message: `duplicate route id '${route.id}'`,
        });
      }
      seen.add(route.id);

      // The dimensions resolve across both layers, so the conflict is judged on
      // the *resolved* rules: a defaults-level block conflicts with a route-level
      // compare_headers entry and vice versa (spec Section 8.6).
      const present = {
        set_cookie: Boolean(contract.defaults?.set_cookie ?? route.comparison?.set_cookie),
        location: Boolean(contract.defaults?.location ?? route.comparison?.location),
      };
      for (const name of dimensionHeaderConflicts(route.comparison?.compare_headers, present)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routes', index, 'comparison', 'compare_headers'],
          message: dimensionHeaderConflictMessage(name),
        });
      }
      for (const name of dimensionHeaderConflicts(contract.defaults?.compare_headers, present)) {
        const key = name.trim().toLowerCase();
        if (reportedInDefaults.has(key)) continue;
        reportedInDefaults.add(key);
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaults', 'compare_headers'],
          message: dimensionHeaderConflictMessage(name),
        });
      }
    });
  });

export type Contract = z.infer<typeof contractSchema>;
export type ContractRoute = z.infer<typeof contractRouteSchema>;
