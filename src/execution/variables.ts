import { randomUUID } from 'node:crypto';
import { getAtPath, parseJsonPath } from '../comparison/jsonpath';
import type { HttpResponseRecord } from './http-client';

/**
 * Variable substitution and extraction (spec Sections 7.1 and 4.6). Templates
 * `{{ namespace.key }}` are resolved against scenario variables, environment,
 * and built-ins. A whole-string template (`'{{ variables.payload }}'`) yields
 * the raw value (so an object stays an object); an embedded template is
 * stringified into the surrounding text.
 */

export class VariableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VariableError';
  }
}

export interface VariableContext {
  variables: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
}

const WHOLE_TEMPLATE = /^\s*\{\{\s*(.+?)\s*\}\}\s*$/;
const EMBEDDED_TEMPLATE = /\{\{\s*(.+?)\s*\}\}/g;

function lookupVariable(variables: Record<string, unknown>, path: string, expr: string): unknown {
  if (path === '') {
    throw new VariableError(`{{ ${expr} }} must name a variable (e.g. variables.userId)`);
  }
  let current: unknown = variables;
  for (const segment of path.split('.')) {
    if (
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      segment in current
    ) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      throw new VariableError(`variable '${path}' is not defined (referenced as {{ ${expr} }})`);
    }
  }
  return current;
}

function resolveExpression(expr: string, ctx: VariableContext): unknown {
  const dot = expr.indexOf('.');
  const namespace = dot === -1 ? expr : expr.slice(0, dot);
  const rest = dot === -1 ? '' : expr.slice(dot + 1);

  switch (namespace) {
    case 'variables':
      return lookupVariable(ctx.variables, rest, expr);
    case 'env': {
      const value = ctx.env[rest];
      if (value === undefined) {
        throw new VariableError(
          `environment variable '${rest}' is not set (referenced as {{ ${expr} }})`,
        );
      }
      return value;
    }
    case 'random':
      if (rest === 'uuid') return randomUUID();
      if (rest === 'int') return Math.floor(Math.random() * 2_147_483_647);
      throw new VariableError(
        `unsupported built-in {{ ${expr} }} (expected random.uuid|random.int)`,
      );
    case 'now':
      if (rest === 'iso') return new Date().toISOString();
      if (rest === 'epochMs') return Date.now();
      throw new VariableError(`unsupported built-in {{ ${expr} }} (expected now.iso|now.epochMs)`);
    default:
      throw new VariableError(`unknown variable namespace '${namespace}' in {{ ${expr} }}`);
  }
}

function substituteString(text: string, ctx: VariableContext): unknown {
  const whole = WHOLE_TEMPLATE.exec(text);
  if (whole) return resolveExpression(whole[1].trim(), ctx);
  return text.replace(EMBEDDED_TEMPLATE, (_match, expr) => {
    const value = resolveExpression(String(expr).trim(), ctx);
    return value === null || value === undefined ? '' : String(value);
  });
}

/** Recursively resolve templates in any value (string, array, or object). */
export function substituteValue(value: unknown, ctx: VariableContext): unknown {
  if (typeof value === 'string') return substituteString(value, ctx);
  if (Array.isArray(value)) return value.map((item) => substituteValue(item, ctx));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = substituteValue(item, ctx);
    }
    return out;
  }
  return value;
}

/** Resolve a string template to a string (coercing a whole-template result). */
export function substituteText(text: string, ctx: VariableContext): string {
  const value = substituteString(text, ctx);
  return typeof value === 'string' ? value : String(value);
}

export interface ResponsesForExtraction {
  legacy?: HttpResponseRecord;
  candidate?: HttpResponseRecord;
}

/**
 * The value of a cookie by name from a lossless `setCookie` capture (spec
 * Section 4.6). Only the leading `name=value` pair is read — attributes are
 * asserted, never extracted. The last occurrence wins (RFC 6265), and a name
 * that is not set yields undefined, exactly like a missing header.
 */
function setCookieValue(setCookie: string[], name: string): string | undefined {
  let found: string | undefined;
  for (const header of setCookie) {
    const pair = header.split(';', 1)[0];
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) found = pair.slice(eq + 1).trim();
  }
  return found;
}

/** Resolve an extract rule against the available responses (spec Section 4.6). */
export function extractValue(
  rule: { from: string; path: string },
  responses: ResponsesForExtraction,
): unknown {
  const dot = rule.from.indexOf('.');
  const side = rule.from.slice(0, dot);
  const kind = rule.from.slice(dot + 1);

  let response: HttpResponseRecord | undefined;
  if (side === 'legacy') {
    response = responses.legacy;
  } else if (side === 'new') {
    response = responses.candidate;
  } else {
    // `response.*` is only well-defined for single-target modes (one response).
    if (responses.legacy && responses.candidate) {
      throw new VariableError(
        "extract source 'response.*' is ambiguous when both legacy and new responses exist; use legacy.* or new.*",
      );
    }
    response = responses.candidate ?? responses.legacy;
  }

  if (!response) {
    throw new VariableError(`cannot extract from '${rule.from}': no ${side} response is available`);
  }
  if (kind === 'headers') {
    return response.headers[rule.path.toLowerCase()];
  }
  if (kind === 'set_cookie') {
    return setCookieValue(response.setCookie, rule.path);
  }
  const matches = getAtPath(response.bodyJson, parseJsonPath(rule.path));
  if (matches.length === 0) return undefined;
  return matches.length === 1 ? matches[0] : matches;
}
