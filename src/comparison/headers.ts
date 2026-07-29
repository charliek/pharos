import { asciiLower, maskQueryValue, REDACTED } from './redaction';
import type { Mismatch } from './result';
import type { LocationRules, SetCookieRules } from './rules';

/**
 * The `Set-Cookie` and `Location` comparison dimensions (spec Section 8.6;
 * Limen spec Section 4.2).
 *
 * Both are *dimensions of their own*, not entries in the `compare_headers`
 * allowlist: `Set-Cookie` is multi-valued (the single-value header map would
 * silently drop all but one cookie, spec Section 9.2) and `Location` needs URL
 * semantics rather than string equality. A route opts in by declaring the
 * corresponding block; with the block absent, neither dimension is compared.
 *
 * Everything rendered here is safe to log: cookie *values* are never emitted
 * (only the {@link REDACTED} / {@link EMPTY} / {@link PRESENT} placeholders) and
 * `Location` query values are masked for the sensitive parameter names.
 *
 * The semantics are **lockstep** with Limen's engine: the shared fixture in
 * `tests/fixtures/lockstep/` pins every rule below in both repos.
 */

/**
 * The cap on each mismatch list, mirroring Limen's `DiffLimits::max_differences`
 * default: a pathological response (hundreds of cookies, a query with hundreds
 * of parameters) can never grow an unbounded log line.
 */
export const MAX_DIFFERENCES = 100;

/** Rendered for a cookie value that exists but is empty (never the value itself). */
export const EMPTY = '***EMPTY***';
/** Rendered for a cookie one side set and the other did not. */
export const PRESENT = '***PRESENT***';
/** The reported name of an unparseable `Set-Cookie` entry, which has no name. */
export const MALFORMED_COOKIE = '<malformed>';

export interface HeaderCompareOptions {
  /** Cap on each mismatch list; defaults to {@link MAX_DIFFERENCES}. */
  maxDifferences?: number;
  /** Extra query-parameter names to mask, on top of the built-in secret-bearing ones. */
  sensitiveQueryParams?: string[];
}

export interface DimensionResult {
  mismatches: Mismatch[];
  /** True when the list was clipped at the bound. */
  truncated: boolean;
}

/** A bounded mismatch collector — the cap the body diff would obey, applied per dimension. */
class Bounded {
  private readonly out: Mismatch[] = [];
  private clipped = false;

  constructor(private readonly max: number) {}

  push(mismatch: Mismatch): void {
    if (this.out.length >= this.max) {
      this.clipped = true;
      return;
    }
    this.out.push(mismatch);
  }

  finish(): DimensionResult {
    return { mismatches: this.out, truncated: this.clipped };
  }
}

const empty: DimensionResult = { mismatches: [], truncated: false };

/** A dimension whose whole verdict is one mismatch, well under any bound. */
function single(mismatch: Mismatch): DimensionResult {
  return { mismatches: [mismatch], truncated: false };
}

/**
 * Pair two sequences positionally, running to the longer side's length so an
 * unpaired tail surfaces as `[value, undefined]` / `[undefined, value]`. Both
 * duplicate cookie names and unparseable entries pair this way.
 */
function zipLongest<T>(
  legacy: readonly T[],
  candidate: readonly T[],
): [T | undefined, T | undefined][] {
  const out: [T | undefined, T | undefined][] = [];
  for (let i = 0; i < Math.max(legacy.length, candidate.length); i++) {
    out.push([legacy[i], candidate[i]]);
  }
  return out;
}

/**
 * Walk the union of two maps' keys in sorted order, carrying each side's value.
 * Cookie names, cookie attributes, and `Location` query parameters are all
 * paired by name this way; only the "did they differ" test varies.
 */
function zipByKey<V>(
  legacy: ReadonlyMap<string, V>,
  candidate: ReadonlyMap<string, V>,
): [string, V | undefined, V | undefined][] {
  const keys = [...new Set([...legacy.keys(), ...candidate.keys()])].sort();
  return keys.map((key) => [key, legacy.get(key), candidate.get(key)]);
}

// ---------------------------------------------------------------------------
// Set-Cookie
// ---------------------------------------------------------------------------

/** One cookie attribute: its authored spelling and its value (empty for a flag). */
export interface CookieAttribute {
  name: string;
  value: string;
}

/** A parsed `Set-Cookie` value: `name=value` plus its attribute map. */
export interface ParsedCookie {
  /** The cookie name, compared case-**sensitively** (RFC 6265). */
  name: string;
  /** The cookie value — never rendered into any output. */
  value: string;
  /** Attributes keyed by ASCII-lowercased name (attribute names are case-insensitive). */
  attributes: Map<string, CookieAttribute>;
}

/**
 * Parse one `Set-Cookie` value, or return `undefined` for a value that is not a
 * cookie at all — no `=` in the name/value pair, or an empty name (the values
 * RFC 6265 §5.2 discards). Callers fall back to exact-string comparison for
 * those.
 */
export function parseSetCookie(raw: string): ParsedCookie | undefined {
  const parts = raw.split(';');
  const pair = parts[0] ?? '';
  const separator = pair.indexOf('=');
  if (separator < 0) return undefined;
  const name = pair.slice(0, separator).trim();
  if (name === '') return undefined;
  const value = pair.slice(separator + 1).trim();

  const attributes = new Map<string, CookieAttribute>();
  for (const part of parts.slice(1)) {
    const index = part.indexOf('=');
    // A flag attribute (`Secure`, `HttpOnly`) has a name but no value.
    const attrName = (index < 0 ? part : part.slice(0, index)).trim();
    const attrValue = index < 0 ? '' : part.slice(index + 1).trim();
    if (attrName === '') continue;
    // A repeated attribute keeps its last occurrence, as RFC 6265 §5.2 prescribes.
    attributes.set(asciiLower(attrName), { name: attrName, value: attrValue });
  }
  return { name, value, attributes };
}

/** Every `Set-Cookie` value on a response, split into parsed cookies and unparseable raw entries. */
export function collectCookies(setCookie: readonly string[]): {
  cookies: ParsedCookie[];
  malformed: string[];
} {
  const cookies: ParsedCookie[] = [];
  const malformed: string[] = [];
  for (const raw of setCookie) {
    const parsed = parseSetCookie(raw);
    if (parsed) cookies.push(parsed);
    else malformed.push(raw);
  }
  return { cookies, malformed };
}

/**
 * Group parsed cookies by name, dropping the names the rules ignore. Duplicate
 * names keep response order, which is what makes their pairing positional.
 */
function groupByName(
  cookies: readonly ParsedCookie[],
  ignore: readonly string[],
): Map<string, ParsedCookie[]> {
  const groups = new Map<string, ParsedCookie[]>();
  for (const cookie of cookies) {
    // Cookie names are case-sensitive (RFC 6265), so `ignore_cookies` matches
    // exactly — unlike attribute names below.
    if (ignore.includes(cookie.name)) continue;
    const group = groups.get(cookie.name);
    if (group) group.push(cookie);
    else groups.set(cookie.name, [cookie]);
  }
  return groups;
}

/** How a cookie value is rendered: never the value itself. */
export function renderCookieValue(value: string): string {
  return value === '' ? EMPTY : REDACTED;
}

/**
 * Compare the `Set-Cookie` dimension of two responses, reading the lossless
 * `setCookie` capture (spec Section 9.2) rather than the single-value header map.
 */
export function compareSetCookie(
  rules: SetCookieRules,
  legacy: readonly string[],
  candidate: readonly string[],
  options: HeaderCompareOptions = {},
): DimensionResult {
  if (!rules.compare) return empty;
  const legacySide = collectCookies(legacy);
  const candidateSide = collectCookies(candidate);
  const legacyGroups = groupByName(legacySide.cookies, rules.ignore_cookies);
  const candidateGroups = groupByName(candidateSide.cookies, rules.ignore_cookies);
  const ignoredAttributes = rules.ignore_attributes.map(asciiLower);

  const out = new Bounded(options.maxDifferences ?? MAX_DIFFERENCES);
  for (const [name, legacyGroup, candidateGroup] of zipByKey(legacyGroups, candidateGroups)) {
    // Same-name cookies pair positionally within their group; a group that runs
    // out on one side leaves an unpaired cookie, i.e. a presence mismatch.
    for (const [l, c] of zipLongest(legacyGroup ?? [], candidateGroup ?? [])) {
      if (l && c) {
        compareCookiePair(rules, ignoredAttributes, l, c, out);
        continue;
      }
      out.push({
        path: `set_cookie.${name}`,
        kind: 'set_cookie.presence',
        expected: l ? PRESENT : undefined,
        actual: c ? PRESENT : undefined,
        message: `cookie '${name}' set by ${l ? 'legacy' : 'new'} only`,
      });
    }
  }

  // Unparseable entries pair positionally with each other and fall back to
  // exact-string comparison — rendered as redacted, since an entry that could
  // not be parsed may still be carrying a secret.
  for (const [l, c] of zipLongest(legacySide.malformed, candidateSide.malformed)) {
    if (l === c) continue;
    out.push({
      path: `set_cookie.${MALFORMED_COOKIE}`,
      kind: 'set_cookie.malformed',
      expected: l === undefined ? undefined : REDACTED,
      actual: c === undefined ? undefined : REDACTED,
      message: 'unparseable Set-Cookie entry differs (compared as an exact string)',
    });
  }
  return out.finish();
}

/** Compare one paired cookie: its value (per `compare_values`) and its attributes. */
function compareCookiePair(
  rules: SetCookieRules,
  ignoredAttributes: readonly string[],
  legacy: ParsedCookie,
  candidate: ParsedCookie,
  out: Bounded,
): void {
  const valueDiffers =
    rules.compare_values === 'exact'
      ? legacy.value !== candidate.value
      : // `presence` asks only whether the two sides *agree* that a value exists;
        // the values themselves are never compared. Both empty is agreement, not
        // a failure — that is the cookie-deletion shape (`session=; Max-Age=0`)
        // both sides emit on logout.
        (legacy.value === '') !== (candidate.value === '');
  if (valueDiffers) {
    out.push({
      path: `set_cookie.${legacy.name}`,
      kind: 'set_cookie.value',
      expected: renderCookieValue(legacy.value),
      actual: renderCookieValue(candidate.value),
      message: `cookie '${legacy.name}' value differs`,
    });
  }

  for (const [key, l, c] of zipByKey(legacy.attributes, candidate.attributes)) {
    if (ignoredAttributes.includes(key)) continue;
    if (l && c && l.value === c.value) continue;
    // Report the attribute under its authored spelling, preferring legacy's.
    const attribute = (l ?? c)?.name ?? key;
    out.push({
      path: `set_cookie.${legacy.name}.${attribute}`,
      kind: 'set_cookie.attribute',
      // Attribute values (`Path`, `SameSite`, `Domain`, …) carry no secret, so
      // they are shown verbatim — that is the whole point of this mismatch.
      expected: l?.value,
      actual: c?.value,
      message: `cookie '${legacy.name}' attribute '${attribute}' differs`,
    });
  }
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

/**
 * A response header by name, matched case-insensitively. Live responses arrive
 * lowercased from `fetch`, but a recording fixture carries whatever case it was
 * written with, so the lookup cannot assume either.
 */
export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const target = asciiLower(name);
  for (const [key, value] of Object.entries(headers)) {
    if (asciiLower(key) === target) return value;
  }
  return undefined;
}

/** A response's `Location` header in the three states comparison cares about. */
export interface LocatedUrl {
  /** The raw header value, absent when the response sent no `Location`. */
  raw?: string;
  /** The resolved URL, absent when the header is missing *or* unresolvable. */
  url?: URL;
}

/**
 * Resolve a response's `Location`, relative values against the URL of the request
 * that produced the response (RFC 9110 §10.2.2) — the same resolution a browser
 * performs. With no request URL, a relative value cannot be resolved and takes
 * the exact-string fallback.
 */
export function locateUrl(
  headers: Record<string, string>,
  requestUrl: string | undefined,
): LocatedUrl {
  const raw = headerValue(headers, 'location');
  if (raw === undefined) return {};
  try {
    return { raw, url: new URL(raw, requestUrl) };
  } catch {
    return { raw };
  }
}

/** Ports a scheme implies, so `https://a` and `https://a:443` are one origin. */
const DEFAULT_PORTS: Record<string, number> = {
  'http:': 80,
  'https:': 443,
  'ws:': 80,
  'wss:': 443,
  'ftp:': 21,
};

/**
 * A URL's origin as the three parts `origin: exact` compares: scheme, host, and
 * *effective* port.
 *
 * Deliberately **not** `URL.origin`: that returns the string `"null"` for
 * non-special schemes (`mailto:`, `file:`), which would make two identical
 * `mailto:` Locations compare as two distinct opaque origins — and Rust's
 * `Url::origin` reports those differently again, which is exactly the
 * cross-engine drift the lockstep obligation forbids.
 */
function originParts(url: URL): [string, string, number | undefined] {
  const port = url.port === '' ? DEFAULT_PORTS[url.protocol] : Number(url.port);
  return [url.protocol, url.hostname, port];
}

/** Whether two URLs share the compared `(scheme, host, effective port)` triple. */
function sameOrigin(legacy: URL, candidate: URL): boolean {
  const [ls, lh, lp] = originParts(legacy);
  const [cs, ch, cp] = originParts(candidate);
  return ls === cs && lh === ch && lp === cp;
}

/** Render the compared origin parts; a scheme with no host renders bare (`mailto:`). */
function renderOrigin(url: URL): string {
  const [scheme, host, port] = originParts(url);
  if (host === '') return scheme;
  return port === undefined ? `${scheme}//${host}` : `${scheme}//${host}:${port}`;
}

/**
 * Render a URL down to origin + path — enough to say *where* a side redirected.
 * Built from the compared parts rather than sliced out of the URL, so a
 * `user:password@` userinfo is dropped, as is the query, which may carry tokens.
 */
function renderLocation(url: URL): string {
  return `${renderOrigin(url)}${url.pathname}`;
}

/**
 * How one side is rendered in a presence mismatch: its target when resolvable,
 * redacted when it sent something unparseable, nothing when it sent no
 * `Location` at all.
 */
function renderSide(side: LocatedUrl): string | undefined {
  if (side.url) return renderLocation(side.url);
  return side.raw === undefined ? undefined : REDACTED;
}

/** The query as `name -> values`, minus the ignored parameter names (case-sensitive). */
export function queryMap(url: URL, ignore: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [name, value] of url.searchParams) {
    if (ignore.includes(name)) continue;
    const values = map.get(name);
    if (values) values.push(value);
    else map.set(name, [value]);
  }
  return map;
}

/**
 * Compare the `Location` dimension of two responses. `legacyRequestUrl` /
 * `candidateRequestUrl` are the URLs of the requests that produced each
 * response, against which a relative `Location` is resolved.
 */
export function compareLocation(
  rules: LocationRules,
  legacy: { headers: Record<string, string>; requestUrl?: string },
  candidate: { headers: Record<string, string>; requestUrl?: string },
  options: HeaderCompareOptions = {},
): DimensionResult {
  if (!rules.compare) return empty;
  const l = locateUrl(legacy.headers, legacy.requestUrl);
  const c = locateUrl(candidate.headers, candidate.requestUrl);

  // Neither side redirected: nothing to compare.
  if (l.raw === undefined && c.raw === undefined) return empty;
  // Exactly one side did: a presence mismatch.
  if (l.raw === undefined || c.raw === undefined) {
    return single({
      path: 'location',
      kind: 'location.presence',
      expected: renderSide(l),
      actual: renderSide(c),
      message: `Location sent by ${l.raw === undefined ? 'new' : 'legacy'} only`,
    });
  }
  if (!l.url || !c.url) {
    // At least one side could not be resolved to a URL: exact-string fallback
    // over the raw header values.
    if (l.raw === c.raw) return empty;
    return single({
      path: 'location',
      kind: 'location.raw',
      // An unresolvable value cannot be parsed, so its query cannot be
      // selectively masked either; render neither side.
      expected: REDACTED,
      actual: REDACTED,
      message: 'unresolvable Location differs (compared as an exact string)',
    });
  }
  return compareTargets(rules, l.url, c.url, options);
}

/** Part-wise comparison of two resolved `Location` URLs. */
function compareTargets(
  rules: LocationRules,
  legacy: URL,
  candidate: URL,
  options: HeaderCompareOptions,
): DimensionResult {
  const out = new Bounded(options.maxDifferences ?? MAX_DIFFERENCES);
  // `origin: ignore` exists for a legacy and a new service that intentionally
  // redirect to different hosts for the same logical destination.
  if (rules.origin === 'exact' && !sameOrigin(legacy, candidate)) {
    out.push({
      path: 'location.origin',
      kind: 'location.origin',
      expected: renderOrigin(legacy),
      actual: renderOrigin(candidate),
      message: 'Location origin differs',
    });
  }
  if (legacy.pathname !== candidate.pathname) {
    out.push({
      path: 'location.path',
      kind: 'location.path',
      expected: legacy.pathname,
      actual: candidate.pathname,
      message: 'Location path differs',
    });
  }
  const legacyQuery = queryMap(legacy, rules.ignore_query_params);
  const candidateQuery = queryMap(candidate, rules.ignore_query_params);
  for (const [param, l, c] of zipByKey(legacyQuery, candidateQuery)) {
    // Repeated names compare as an ordered list of values, so the comparison is
    // over the whole list — serialized, never joined, so a value containing the
    // separator cannot masquerade as two.
    if (l && c && JSON.stringify(l) === JSON.stringify(c)) continue;
    out.push({
      path: `location.query.${param}`,
      kind: 'location.query',
      expected: maskQueryValue(param, l?.join(','), options.sensitiveQueryParams),
      actual: maskQueryValue(param, c?.join(','), options.sensitiveQueryParams),
      message: `Location query param '${param}' differs`,
    });
  }
  return out.finish();
}
