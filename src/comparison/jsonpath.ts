/**
 * The supported JSONPath subset (spec Section 8.4), kept deliberately small and
 * **identical to Limen's** so a behavioral contract is portable between the two
 * tools unchanged. Exactly three forms are supported:
 *
 *   - `$.field`
 *   - `$.nested.field`
 *   - `$.items[*].field`   (a `[*]` wildcard over array elements)
 *
 * Anything outside this subset is a load-time validation error. The subset may
 * expand later, but only in lockstep with Limen.
 *
 * This module owns parsing/validation; the comparison engine (added later) adds
 * the read/remove/transform operations that walk these segments over a value.
 */

export type JsonPathSegment =
  | { readonly type: 'key'; readonly key: string }
  | { readonly type: 'wildcard' };

/** Human-readable description of the supported forms, reused in error messages. */
export const SUPPORTED_SUBSET = '$.field, $.nested.field, $.items[*].field';

/** A field-name segment: alphanumerics plus `_` and `-`. */
const KEY_PATTERN = /^[A-Za-z0-9_-]+/;

export class JsonPathError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`invalid JSONPath '${path}': ${detail} (supported subset: ${SUPPORTED_SUBSET})`);
    this.name = 'JsonPathError';
  }
}

/**
 * Parse a path into segments, throwing {@link JsonPathError} if it falls outside
 * the supported subset. The root `$` yields an empty segment list.
 */
export function parseJsonPath(path: string): JsonPathSegment[] {
  if (typeof path !== 'string' || path.length === 0) {
    throw new JsonPathError(String(path), 'path must be a non-empty string');
  }
  if (path[0] !== '$') {
    throw new JsonPathError(path, "path must start with '$'");
  }

  const segments: JsonPathSegment[] = [];
  let i = 1;
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      const match = KEY_PATTERN.exec(path.slice(i + 1));
      if (!match) {
        throw new JsonPathError(path, `expected a field name after '.' at position ${i}`);
      }
      segments.push({ type: 'key', key: match[0] });
      i += 1 + match[0].length;
    } else if (ch === '[') {
      if (path.slice(i, i + 3) === '[*]') {
        segments.push({ type: 'wildcard' });
        i += 3;
      } else {
        throw new JsonPathError(
          path,
          `only the '[*]' wildcard is supported, found '${path.slice(i)}' at position ${i}`,
        );
      }
    } else {
      throw new JsonPathError(path, `unexpected character '${ch}' at position ${i}`);
    }
  }

  // A path must reference at least one field (the bare root `$` is not a
  // supported form), and every `[*]` wildcard must sit between two fields, as in
  // `$.items[*].field` — never at the root or as a trailing element.
  if (segments.length === 0) {
    throw new JsonPathError(path, 'path must reference at least one field');
  }
  for (let s = 0; s < segments.length; s++) {
    if (segments[s].type !== 'wildcard') continue;
    const keyBefore = s > 0 && segments[s - 1].type === 'key';
    const keyAfter = s < segments.length - 1 && segments[s + 1].type === 'key';
    if (!keyBefore || !keyAfter) {
      throw new JsonPathError(
        path,
        "the '[*]' wildcard must appear between two fields, as in $.items[*].field",
      );
    }
  }
  return segments;
}

/** Whether `path` is within the supported subset. */
export function isSupportedJsonPath(path: string): boolean {
  try {
    parseJsonPath(path);
    return true;
  } catch {
    return false;
  }
}
