import type { z } from 'zod';

/** A single validation problem, addressed by a dotted field path. */
export interface FieldIssue {
  path: string;
  message: string;
}

/** Render a zod issue path (`['routes', 0, 'id']`) as `routes[0].id`. */
export function formatFieldPath(path: ReadonlyArray<string | number>): string {
  if (path.length === 0) return '(root)';
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else {
      out += out === '' ? segment : `.${segment}`;
    }
  }
  return out;
}

/** Convert a {@link z.ZodError} into flat, field-addressed issues. */
export function zodIssuesToFieldIssues(error: z.ZodError): FieldIssue[] {
  return error.issues.map((issue) => ({
    path: formatFieldPath(issue.path),
    message: issue.message,
  }));
}

/**
 * A validation failure tied to a specific file. Carries every field-level issue
 * so the CLI can print actionable, file + field-addressed errors (spec Section
 * 16: "reports errors with file path and field path").
 */
export class ValidationError extends Error {
  constructor(
    readonly file: string,
    readonly issues: FieldIssue[],
  ) {
    const count = issues.length;
    super(`${file}: ${count} validation ${count === 1 ? 'error' : 'errors'}`);
    this.name = 'ValidationError';
  }
}

/**
 * Parse `value` with a zod `schema`, throwing a file-addressed
 * {@link ValidationError} on failure. Collapses the safeParse → throw boilerplate
 * shared by every loader.
 */
export function validateWithSchema<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
  file: string,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(file, zodIssuesToFieldIssues(result.error));
  }
  return result.data;
}
