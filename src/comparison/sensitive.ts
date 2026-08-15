import { REDACTED } from './redaction';
import type { Mismatch } from './result';

/**
 * Value-based sensitivity (spec Section 8.5, the propagation half).
 *
 * Name- and path-based redaction (`./redaction.ts`) masks a secret where it is
 * *declared*: a header called `authorization`, a JSON path called `$.token`. It
 * cannot help once a value has been **extracted into a variable** and
 * substituted somewhere else — a session cookie captured by `extract` and later
 * sent as a JSON body field, a custom header, or a query parameter is, to every
 * static list, an ordinary value.
 *
 * This registry closes that gap by tracking the *values themselves*. A scenario
 * run registers each value extracted from a secret-bearing source (every
 * `*.set_cookie` / `*.headers` rule, plus any rule marked `sensitive: true`),
 * and every boundary where data leaves execution for an output surface masks by
 * value before serializing. Deliberately **not** taint tracking through
 * substitution: substitution is unaffected — the wire still carries the real
 * value — and masking happens at output boundaries only.
 *
 * Masking policy, pinned:
 *
 * - **Exact scalar equality masks regardless of length.** The repo invariant is
 *   that no secret value appears in any output; a short secret is still a
 *   secret, so there is no minimum-length exemption for a whole value.
 * - **Substring replacement inside a composite string applies only to values of
 *   {@link MIN_SUBSTRING_LENGTH} characters or more.** Replacing a 3-character
 *   value everywhere it happens to occur inside unrelated text would corrupt
 *   every diff in the run; the length floor is the over-masking guard.
 * - **Candidates are tried longest-first**, so an overlapping or contained
 *   value cannot mask half of a longer one.
 * - **The first registration of a value wins** when several variables share it,
 *   so the marker is deterministic across runs (invariant 6).
 *
 * Scope and known bounds:
 *
 * - **What is masked is data derived from a request or a response, plus error
 *   text** — bodies, headers, cookies, URLs, mismatches, diffs. Author-written
 *   identifiers are deliberately left alone: scenario and step ids, artifact
 *   directory names, recording metadata, durations and status codes. They are
 *   constants the author typed (or protocol numerics), never a path a value
 *   extracted from a response can travel down, and masking them would corrupt
 *   recordings and report addressing for no gain.
 * - **A value shorter than {@link MIN_SUBSTRING_LENGTH} is masked only when it
 *   stands alone.** `Bearer abc123` keeps a 6-character `abc123`, because
 *   replacing so short a string everywhere would corrupt unrelated output.
 *   Registration warns about that residual, naming the variable (never the
 *   value).
 * - **Hook code is a trust boundary.** Hooks receive the raw variable store by
 *   design (they need real credentials to do setup work) and can print or ship
 *   it anywhere; Pharos cannot intercept arbitrary author code's I/O. The
 *   no-secret invariant covers Pharos's own output surfaces — a hook's own
 *   logging is the hook author's responsibility.
 */

/**
 * The replacement written wherever a registered value is found. The variable
 * name is author-written text embedded verbatim, so callers must pass it
 * through {@link SensitiveValues.safeName} first — see that method.
 */
export function sensitiveMarker(variableName: string): string {
  return `[REDACTED:${variableName}]`;
}

/**
 * The shortest value that may be replaced *inside* a larger string. Below it,
 * only a whole-value (exact equality) match masks — see the class doc.
 */
export const MIN_SUBSTRING_LENGTH = 8;

/**
 * The text form of a value eligible for registration. Strings and numeric
 * scalars only: a boolean or null "secret" is not a credential, and registering
 * `true` would mask every boolean in every output surface (exact equality has
 * no length floor). Objects and arrays are walked by {@link
 * SensitiveValues.register}, which registers their scalar leaves.
 */
function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'bigint') return String(value);
  return undefined;
}

/**
 * The encoded forms a value takes on the way to an output surface, so that
 * masking is encoding-aware: `buildUrl` percent-encodes a query value before it
 * lands in a timeout/network error message, and a `form` body is urlencoded
 * (space as `+`) rather than percent-encoded. Exact-string matching against the
 * raw value alone would miss both.
 */
function variantsOf(text: string): string[] {
  const variants = [text];
  const percent = encodeURIComponent(text);
  if (percent !== text) variants.push(percent);
  const params = new URLSearchParams();
  params.append('v', text);
  const form = params.toString().slice('v='.length);
  if (form !== text && form !== percent) variants.push(form);
  return variants;
}

interface Candidate {
  /** The literal text to look for (a raw value or one of its encoded forms). */
  text: string;
  /** The variable that first registered it — what the marker names. */
  name: string;
  /** Registration sequence, the deterministic tie-break for equal-length candidates. */
  order: number;
}

/** Where a registration warning goes; a sink so tests can capture it. */
export type WarnFn = (message: string) => void;

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Bounds on the structure walk in {@link SensitiveValues.register}. A live
 * response body is `JSON.parse` output and therefore acyclic and shallow, but a
 * replayed recording's `bodyJson` is schema-`unknown` and a YAML alias can
 * preserve a cycle — an unguarded walk would then recurse until the stack dies.
 * The depth cap also stops a pathologically deep acyclic body from exhausting
 * the stack, and the node cap bounds the total work. Both are far above any
 * real credential payload, so hitting one means the extraction is not what its
 * author thinks it is.
 */
const MAX_REGISTER_DEPTH = 32;
const MAX_REGISTER_NODES = 10_000;

/**
 * What a masked structure renders where a container references itself. A note
 * rather than `{}`, in the same spirit as the artifact writer's omitted-body
 * note: an empty object would read as data the value never had.
 */
export const CIRCULAR_NOTE = '[circular reference omitted]';

/** Mutable state threaded through one `register` walk. */
interface WalkBudget {
  nodes: number;
  /** True once a cap stopped the walk — the caller warns, since values were missed. */
  capped: boolean;
}

/**
 * The scenario-scoped registry of extracted secret values. Created per scenario
 * run and carried on the variable context beside `variables`, so it lives and
 * dies with the values it describes and nothing leaks between scenarios.
 */
export class SensitiveValues {
  /** Longest-first, then registration order — the order masking tries them in. */
  private readonly candidates: Candidate[] = [];
  /** Candidate text → the variable name that first claimed it. */
  private readonly byText = new Map<string, string>();
  /** `<kind>:<variable>` pairs already warned about, so a re-extraction warns once. */
  private readonly warned = new Set<string>();
  /** Set when a candidate is added; the sort is deferred to the first read. */
  private unsorted = false;
  private order = 0;

  constructor(private readonly warn: WarnFn = defaultWarn) {}

  /**
   * Register a value (and its encoded forms) as sensitive under `name`.
   *
   * Objects and arrays are walked to their **scalar leaves**: an extraction can
   * yield a whole credential bundle (`{ access_token, refresh_token }`) or a
   * wildcard match, and registering only the container would register nothing
   * at all while every secret inside it stayed live. Empty strings, booleans,
   * null, and already-registered texts are skipped. Keys are structure, not
   * values, and are not registered.
   *
   * The walk is bounded (see {@link MAX_REGISTER_DEPTH}): a cycle is safe, and
   * a structure past the caps stops the descent and warns — silently failing to
   * register a secret is fail-open, so it must be said out loud.
   */
  register(name: string, value: unknown): void {
    const budget: WalkBudget = { nodes: MAX_REGISTER_NODES, capped: false };
    this.walk(name, value, 0, new WeakSet<object>(), budget);
    if (budget.capped) this.warnStructureCapped(name);
  }

  /**
   * One node of the registration walk. `seen` makes a cyclic (or merely shared)
   * structure safe *without* losing anything: every reachable object is walked
   * exactly once, so every reachable scalar is still registered — which is why
   * a cycle alone does not warn, while a cap does.
   */
  private walk(
    name: string,
    value: unknown,
    depth: number,
    seen: WeakSet<object>,
    budget: WalkBudget,
  ): void {
    if (budget.nodes <= 0) {
      budget.capped = true;
      return;
    }
    budget.nodes -= 1;
    if (value !== null && typeof value === 'object') {
      const container = value as object;
      if (seen.has(container)) return; // already walked: a cycle or a shared node
      if (depth >= MAX_REGISTER_DEPTH) {
        budget.capped = true;
        return;
      }
      seen.add(container);
      for (const item of Object.values(container)) {
        this.walk(name, item, depth + 1, seen, budget);
      }
      return;
    }
    const text = scalarText(value);
    if (text === undefined || text === '') return;
    this.warnIfUnmaskableInComposites(name, text);
    for (const variant of variantsOf(text)) this.add(name, variant);
  }

  /** Warn once per variable per kind; the message never carries the value itself. */
  private warnOnce(kind: string, name: string, message: string): void {
    if (this.warned.has(`${kind}:${name}`)) return;
    this.warned.add(`${kind}:${name}`);
    this.warn(message);
  }

  /**
   * Warn when a registered value is too short to be replaced inside a larger
   * string, so an operator learns about the residual instead of assuming a
   * guarantee the length floor does not give. Names the variable and never the
   * value — a warning that printed the secret would be the very leak it reports.
   */
  private warnIfUnmaskableInComposites(name: string, text: string): void {
    if (text.length >= MIN_SUBSTRING_LENGTH) return;
    this.warnOnce(
      'short',
      name,
      `warning: sensitive value '${name}' is shorter than ${MIN_SUBSTRING_LENGTH} characters — ` +
        'it is masked wherever it appears on its own, but an occurrence inside a larger string ' +
        "(e.g. 'Bearer <value>') is left as-is, because replacing so short a string everywhere " +
        'would corrupt unrelated output',
    );
  }

  /** Warn when the bounded walk gave up: whatever lay beyond the cap is unmasked. */
  private warnStructureCapped(name: string): void {
    this.warnOnce(
      'capped',
      name,
      `warning: sensitive value '${name}' is too deeply nested or too large to register ` +
        `completely (limits: depth ${MAX_REGISTER_DEPTH}, ${MAX_REGISTER_NODES} nodes) — ` +
        'values beyond that bound are NOT masked in output; extract a narrower path instead',
    );
  }

  private add(name: string, text: string): void {
    if (this.byText.has(text)) return; // first registration wins
    this.byText.set(text, name);
    this.candidates.push({ text, name, order: this.order++ });
    this.unsorted = true;
  }

  /**
   * The candidates, longest-first with registration order as the deterministic
   * tie-break. Sorted lazily on first read rather than on every `add`, since a
   * bundle extraction registers many values in a row before anything is masked.
   */
  private get ordered(): readonly Candidate[] {
    if (this.unsorted) {
      this.candidates.sort((a, b) => b.text.length - a.text.length || a.order - b.order);
      this.unsorted = false;
    }
    return this.candidates;
  }

  /**
   * The marker for a candidate, with the variable *name* made safe first.
   *
   * A name is author-written text that lands in output verbatim, so a variable
   * named with the literal value of another registered secret would have the
   * marker reintroduce it. The name is therefore masked in turn — against every
   * candidate, its own included (a variable whose name *is* its value would
   * otherwise publish it) — using the flat {@link REDACTED} marker rather than a
   * named one. Flat keeps the substitution exactly one level deep, so two
   * variables whose names contain each other's values cannot recurse.
   */
  private markerFor(name: string): string {
    return sensitiveMarker(this.safeName(name));
  }

  private safeName(name: string): string {
    if (this.byText.has(name)) return REDACTED;
    let out = name;
    for (const candidate of this.ordered) {
      if (candidate.text.length < MIN_SUBSTRING_LENGTH) continue;
      if (out.includes(candidate.text)) out = out.split(candidate.text).join(REDACTED);
    }
    // A single longest-first pass can *synthesize* a registered value: splicing
    // REDACTED in between two neighbours can produce a third secret's text
    // exactly (`preAAAAAAAApost` + a secret `pre***REDACTED***post`). Rather
    // than iterate to a fixpoint, fail closed — if anything registered is still
    // present, at any length, this name is not safe to print at all. The blast
    // radius is one marker label, so the strictest possible check is affordable
    // here in a way it would not be over arbitrary output.
    if (this.candidates.some((candidate) => out.includes(candidate.text))) return REDACTED;
    return out;
  }

  /** True when nothing is registered — every mask call is then the identity. */
  get isEmpty(): boolean {
    return this.candidates.length === 0;
  }

  /** The variable names registered, in registration order (for tests/diagnostics). */
  get names(): string[] {
    return [...new Set(this.candidates.map((candidate) => candidate.name))];
  }

  /**
   * Mask a string: a whole value is replaced at any length, an embedded one
   * only from {@link MIN_SUBSTRING_LENGTH} characters up. Replacement is done
   * with `split`/`join`, never a regex, so a value containing regex
   * metacharacters is matched literally and can never inject a pattern.
   */
  maskString(text: string): string {
    if (this.candidates.length === 0) return text;
    const exact = this.byText.get(text);
    if (exact !== undefined) return this.markerFor(exact);
    let out = text;
    for (const candidate of this.ordered) {
      if (candidate.text.length < MIN_SUBSTRING_LENGTH) continue;
      if (!out.includes(candidate.text)) continue;
      out = out.split(candidate.text).join(this.markerFor(candidate.name));
    }
    return out;
  }

  /**
   * Mask a value structurally — **before** it is serialized, never after. A
   * secret embedded in an already-serialized string (a JSON body text, a
   * urlencoded form) may be escaped or encoded beyond recognition, so every
   * boundary masks the structure it still has and re-serializes from the masked
   * form.
   *
   * Object keys are masked too: a secret used as a key would otherwise reach
   * output through the key and through every mismatch path built from it.
   */
  maskValue(value: unknown): unknown {
    if (this.candidates.length === 0) return value;
    return this.maskNode(value, new WeakSet<object>());
  }

  /**
   * One node of the masking walk. `path` holds the containers currently open —
   * added on the way down and **removed on the way out**, so it detects a true
   * cycle (a node reachable from itself) without collapsing a structure that
   * merely repeats a shared child in two places, which is ordinary data and
   * must still render twice.
   *
   * That is the opposite of {@link walk}'s never-deleted `seen`: registration
   * is a set union over reachable scalars, where visiting a shared node once is
   * enough, while masking *renders* and must reproduce every position.
   */
  private maskNode(value: unknown, path: WeakSet<object>): unknown {
    if (typeof value === 'string') return this.maskString(value);
    if (typeof value === 'number' || typeof value === 'bigint') {
      const text = scalarText(value);
      const name = text === undefined ? undefined : this.byText.get(text);
      // A numeric scalar equal to a registered value becomes the marker string:
      // a deliberate type widening at an output boundary, preferred over
      // printing the secret.
      return name === undefined ? value : this.markerFor(name);
    }
    if (value !== null && typeof value === 'object') {
      const container = value as object;
      // A custom comparator may hand back a self-referencing `expected`/`actual`
      // (spec Section 8.3 does not constrain the shape); recursing into it would
      // exhaust the stack and take the whole comparison result down with it. The
      // cycle renders as a note instead of `{}`, which would silently claim the
      // value was an empty object.
      if (path.has(container)) return CIRCULAR_NOTE;
      path.add(container);
      try {
        if (Array.isArray(value)) return value.map((item) => this.maskNode(item, path));
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) {
          out[this.maskString(key)] = this.maskNode(item, path);
        }
        return out;
      } finally {
        path.delete(container);
      }
    }
    return value;
  }
}

/** Mask a string with an optional registry (absent or empty = unchanged). */
export function maskText(text: string, sensitive?: SensitiveValues): string {
  return sensitive === undefined || sensitive.isEmpty ? text : sensitive.maskString(text);
}

/**
 * Mask an `HttpResponseRecord`-style error's `message`, preserving `type`. The
 * one field of an error worth masking structurally: `type` is a fixed
 * classifier (`'request'`, `'timeout'`, ...), never a value a response could
 * carry a secret through. Shared by every output boundary that passes an
 * error through unchanged otherwise (comparator view, recording, artifact).
 */
export function maskError<T extends { message: string }>(
  error: T | undefined,
  sensitive?: SensitiveValues,
): T | undefined {
  return error === undefined
    ? undefined
    : { ...error, message: maskText(error.message, sensitive) };
}

/**
 * Mask a structure with an optional registry, preserving its declared type. The
 * shape is preserved; the one exception is a numeric scalar exactly equal to a
 * registered value, which becomes the marker string (see
 * {@link SensitiveValues.maskValue}).
 */
export function maskValue<T>(value: T, sensitive?: SensitiveValues): T {
  return (sensitive === undefined || sensitive.isEmpty ? value : sensitive.maskValue(value)) as T;
}

/**
 * Mask every value a mismatch carries — its `expected`/`actual` values, its
 * message, and its path (a secret can be a JSON object key). Applied where a
 * comparison result is assembled, i.e. **before** the diff text is rendered, so
 * the renderer's bounded preview can only ever truncate an already-masked value.
 */
export function maskMismatches(mismatches: Mismatch[], sensitive?: SensitiveValues): Mismatch[] {
  if (sensitive === undefined || sensitive.isEmpty) return mismatches;
  return mismatches.map((mismatch) => {
    const masked: Mismatch = {
      ...mismatch,
      path: sensitive.maskString(mismatch.path),
      message: sensitive.maskString(mismatch.message),
    };
    if (masked.expected !== undefined) masked.expected = sensitive.maskValue(masked.expected);
    if (masked.actual !== undefined) masked.actual = sensitive.maskValue(masked.actual);
    return masked;
  });
}
