import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defaultConfig } from './config/config';
import { ConfigError } from './errors';

/**
 * Scaffolding behind the `init` command (spec Section 19.2). Kept out of the
 * CLI layer so the generated tree can be produced and asserted on in-process:
 * the acceptance criterion is that `validate` passes on it unmodified (Section
 * 16), which the tests check by calling `validateProject` against a scaffolded
 * tmpdir rather than by spawning a subprocess.
 *
 * Every template is an inline string rather than a file under `templates/`, so
 * a consumer's pinned git dependency carries them without widening the
 * `package.json` `files` allowlist (Section 19.1).
 */

export const DEFAULT_SERVICE = 'my-service';

/**
 * A service name has to survive three roles: a filename
 * (`<service>.contract.yaml`), the contract/scenario `service` field, and the
 * generated package name. The slug rule is the intersection.
 */
const SERVICE_PATTERN = /^[a-z0-9]+([-.][a-z0-9]+)*$/;

export interface ScaffoldFile {
  /** Path relative to the scaffold root, POSIX-separated. */
  path: string;
  contents: string;
}

export interface ScaffoldOptions {
  /** Directory to scaffold into; defaults to the current working directory. */
  dir?: string;
  service?: string;
  /** Overwrite files that already exist instead of refusing (spec Section 19.2). */
  force?: boolean;
}

export interface ScaffoldResult {
  /** Absolute scaffold root. */
  dir: string;
  service: string;
  /** Relative paths written, in generation order. */
  written: string[];
  /** Relative paths that existed and were overwritten (only possible with `force`). */
  overwritten: string[];
}

/** One reason the scaffold cannot be written, addressed by a scaffold-relative path. */
export interface ScaffoldConflict {
  /** Path relative to the scaffold root (`.` for the root itself). */
  path: string;
  /** Rendered after the path in CLI output. */
  reason: string;
  /**
   * True when `--force` cannot resolve it. Overwriting a stale *file* is what
   * `--force` means; a path that exists with the wrong *type* (a directory
   * where a file goes, a file where a directory goes) would make `writeFileSync`
   * or `mkdirSync` throw mid-write, so it is refused either way rather than
   * silently deleted.
   */
  fatal: boolean;
}

/**
 * Raised when `init` cannot write its file set. Carries every conflict so the
 * CLI can name them all (spec Section 19.2: "refuses to overwrite them and
 * exits non-zero, naming the conflicting files").
 */
export class ScaffoldConflictError extends Error {
  constructor(
    readonly dir: string,
    readonly conflicts: ScaffoldConflict[],
  ) {
    const fatal = conflicts.some((conflict) => conflict.fatal);
    super(
      `refusing to scaffold into ${dir}: ${conflicts.length} path conflict(s)` +
        (fatal ? '' : '; re-run with --force to overwrite'),
    );
    this.name = 'ScaffoldConflictError';
  }
}

function assertValidService(service: string): void {
  if (!SERVICE_PATTERN.test(service)) {
    throw new ConfigError([
      `invalid service name ${JSON.stringify(service)} — use lowercase alphanumeric words ` +
        `separated by '-' or '.' (e.g. ${DEFAULT_SERVICE}); it becomes a filename, the ` +
        'contract/scenario `service` field, and the generated package name',
    ]);
  }
}

/**
 * The starter config (spec Section 19.2). Built from {@link defaultConfig} so
 * the scaffolded layout and redaction defaults can never drift from the
 * documented ones — JSON has no comments, so the guidance lives in the README.
 * The `allow_*` safety toggles are deliberately omitted: their default is
 * `false`, and pre-writing them into the file makes flipping one a one-character
 * edit nobody reviews.
 */
function configTemplate(): string {
  const defaults = defaultConfig();
  const config = {
    scenario_dir: defaults.scenario_dir,
    contract_dir: defaults.contract_dir,
    fixture_dir: defaults.fixture_dir,
    report_dir: defaults.report_dir,
    hooks_module: defaults.hooks_module,
    default_timeout_ms: defaults.default_timeout_ms,
    default_headers: {},
    output_mode: defaults.output_mode,
    environment: defaults.environment,
    production_url_patterns: defaults.production_url_patterns,
    redaction: defaults.redaction,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * A minimal, runnable package (spec Section 19.1). The dependency is a
 * placeholder on purpose: Pharos is consumed as a **pinned** git dependency, and
 * a floating `#main` would silently change the harness under a target repo's CI.
 */
function packageJsonTemplate(service: string): string {
  const pkg = {
    name: `${service}-conformance`,
    private: true,
    type: 'module',
    scripts: {
      conformance: 'pharos run',
      validate: 'pharos validate',
      record: 'pharos record',
    },
    dependencies: {
      // Replaced by the user with a real commit SHA — see the README.
      pharos: 'github:charliek/pharos#REPLACE_WITH_PINNED_COMMIT_SHA',
    },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function contractTemplate(service: string): string {
  return `# Behavioral contract for ${service} (spec Section 5.2).
#
# This file is portable, unchanged, to Limen: it owns *what to compare and how*
# — never operational concerns (base URLs, timeouts, safety toggles live in
# pharos.config.json). Every normalization rule is a deliberate exception to the
# default posture of "compare everything", so keep them narrow and reviewed.
version: 1
service: '${service}'
description: >
  Starter contract generated by \`pharos init\`. Add one route per endpoint you
  are migrating, then declare the incidental differences (request ids, server
  timestamps, PII) in the \`json\` normalization block below — either here in
  \`defaults\` or in a per-route \`comparison\` block.

defaults:
  compare_status: true
  compare_body: true
  # Header comparison is opt-in by name — most headers are incidental.
  compare_headers: []
  # json:
  #   ignore_paths:
  #     - "$.metadata.requestId"   # per-request, non-deterministic
  #   redact_paths:
  #     - "$.email"                # PII — never appears in a diff or report

routes:
  - id: health
    match:
      methods: ["GET"]
      path_template: "/health"
    expectations:
      typical_status: 200
    tags: [smoke, read]
`;
}

function scenarioTemplate(service: string): string {
  return `# Example scenario (spec Section 4). \`pharos validate\` passes on this file as
# generated; delete it once you have real scenarios.
#
# \`new_only_assert\` asserts against the new service alone — the right mode for
# an endpoint with no legacy equivalent, and the only one that needs no
# LEGACY_BASE_URL. Switch to \`compare_live\` (with a \`json_semantic\` strategy)
# once there is a legacy response worth diffing against.
version: 1
id: smoke.health
name: Health endpoint responds
description: >
  Smoke check: the new service answers GET /health with 200. Safe everywhere,
  including production, because it is a read with no side effects.
service: '${service}'
tags: [smoke, read]
mode: new_only_assert
safety:
  # Environments this scenario may run in (spec Section 4.5). A run whose
  # \`environment\` is not listed here refuses the scenario rather than skipping
  # it — so keep production out of this list for anything with side effects.
  allowedEnvironments: [local, ci, staging, production]
# Behavioral truth comes from the contract, resolved relative to *this* file.
contract: "../../contracts/${service}.contract.yaml#health"
steps:
  - id: health
    request:
      method: GET
      path: /health
      # Set follow_redirects: false on any step whose redirect hops you need to
      # inspect, extract from, or collect cookies from (see the README).
    compare:
      strategy: explicit_expectations
      expect:
        status: 200
        # Assert as much as is stable — the vocabulary also covers
        # \`headers\`, \`header_absent\`, \`set_cookie\`, and \`location\`.
        # body:
        #   json_paths:
        #     $.status: ok
`;
}

function hooksTemplate(): string {
  return `import type { HookContext } from 'pharos';

/**
 * The hook registry (spec Section 7.2). Pharos loads this module
 * (\`hooks_module\` in pharos.config.json) and resolves hooks, custom
 * comparators, and custom normalizers by name, so scenarios stay declarative.
 *
 * A hook receives the scenario context (variables, env, resolved base URLs) and
 * may return a map of values, which a scenario merges into its variables with
 * \`assign\`. Cleanup hooks always run, even after a failed step.
 */
export const hooks = {
  /** Example: expose an env-provided token to scenarios as {{ variables.token }}. */
  authToken: (ctx: HookContext) => ({ token: ctx.env.AUTH_TOKEN ?? '' }),

  // Example of a setup/cleanup pair talking to the services directly:
  //
  // createFixtureUser: async (ctx: HookContext) => {
  //   const response = await fetch(\`\${ctx.newBaseUrl}/users\`, {
  //     method: 'POST',
  //     headers: { 'content-type': 'application/json' },
  //     body: JSON.stringify({ email: \`test-\${crypto.randomUUID()}@example.com\` }),
  //   });
  //   return { userId: ((await response.json()) as { id: string }).id };
  // },
  //
  // deleteFixtureUser: async (ctx: HookContext, args?: unknown) => {
  //   const userId = (args as { userId?: string } | undefined)?.userId;
  //   if (!userId) return;
  //   // Cleanup is best-effort: never let it mask the scenario result.
  //   await fetch(\`\${ctx.newBaseUrl}/users/\${userId}\`, { method: 'DELETE' }).catch(() => {});
  // },
};

/** Custom comparators (\`compare.strategy: custom\`) and normalizers go here. */
// export const comparators = {};
// export const normalizers = {};
`;
}

function gitignoreTemplate(): string {
  return `# Generated reports (spec Section 11) — regenerated on every run.
reports/

# Recorded legacy fixtures are opt-in: \`pharos record\` writes them, redacted.
# Commit them deliberately (delete this line) once you have reviewed them.
fixtures/recordings/

node_modules/
`;
}

function readmeTemplate(service: string): string {
  return `# ${service} conformance suite

Black-box conformance tests for **${service}**, run by
[Pharos](https://github.com/charliek/pharos). Scenarios issue HTTP requests to
the new service (and, in \`compare_live\` mode, to the legacy one), normalize
both responses per the shared behavioral contract, and report the differences.

Generated by \`pharos init\`. The authoritative reference is Pharos's
\`docs/pharos_spec.md\`; section numbers below point into it.

## Layout

| Path | What it holds |
|---|---|
| \`pharos.config.json\` | Directories, timeouts, environment, redaction (Section 6). |
| \`scenarios/\` | Scenario specs — the executable layer (Section 4). |
| \`contracts/\` | The behavioral contract — shared comparison truth (Section 5). |
| \`hooks/index.ts\` | Named hooks, comparators, normalizers (Section 7.2). |
| \`fixtures/recordings/\` | Recorded legacy responses (git-ignored by default). |
| \`reports/\` | \`report.json\` + \`junit.xml\` (git-ignored). |

## Install

Pharos is consumed as a **pinned git dependency**, not a published npm package
(Section 19.1). Replace the placeholder in \`package.json\`:

\`\`\`json
"dependencies": {
  "pharos": "github:charliek/pharos#<commit-sha>"
}
\`\`\`

Pin a real commit SHA — a floating branch ref would let the harness change
underneath your CI. Then:

\`\`\`bash
bun install
\`\`\`

While iterating locally against an unmerged Pharos change you may point the
dependency at \`"file:../pharos"\`; **never commit that override**.

## Run

Pharos resolves \`pharos.config.json\` and every directory inside it relative to
the **current working directory** (Section 19.3), so run from *this* directory —
not from the repository root if this suite lives in a subdirectory.

\`\`\`bash
bun run validate                 # schema + contract references, no requests
bun run conformance              # run every scenario
bun run conformance -- --scenario smoke.health
bun run conformance -- --include-tag smoke --exclude-tag destructive
bun run record                   # refresh legacy recordings (explicit opt-in)
\`\`\`

A failing required scenario exits non-zero; skipped scenarios are reported
separately and do not fail the run.

## Environment variables

| Variable | Purpose |
|---|---|
| \`NEW_BASE_URL\` | Base URL of the new service (all modes but \`legacy_record\`). |
| \`LEGACY_BASE_URL\` | Base URL of the legacy service (\`compare_live\`, \`legacy_record\`). |
| \`PHAROS_ENVIRONMENT\` | \`local\` \\| \`ci\` \\| \`staging\` \\| \`production\` — the safety-relevant target. |
| \`PHAROS_MODE\` | \`local\` \\| \`ci\` — reporting/recording conventions only. |
| \`ALLOW_DESTRUCTIVE_TESTS\` | Opt in to scenarios marked \`safety.destructive\`. |
| \`ALLOW_PRODUCTION_GUARD_OVERRIDE\` | Additional guard for production-like destructive runs. |
| \`ALLOW_RECORDING_UPDATES\` | Allow \`record\` to write fixtures in CI. |
| \`DEFAULT_TIMEOUT_MS\` | Per-request timeout override. |

Precedence is defaults < \`pharos.config.json\` < environment < CLI flags.

## Safety model

Three independent gates (Sections 4.5, 6.2, 12):

- **\`environment\`** (config or \`PHAROS_ENVIRONMENT\`) names what you are pointed
  at. It is independent of \`output_mode\`.
- **\`safety.allowedEnvironments\`** on a scenario names where that scenario may
  run. Under \`environment: production\`, a scenario that does not list
  \`production\` **fails** (it does not quietly skip) — production is fail-closed.
- **\`production_url_patterns\`** in the config is host globs (e.g.
  \`*.example.com\`) matched against each configured base URL's hostname. A match
  while \`environment\` is not \`production\` aborts the run with a config error
  **before any request** — the guard against pointing a CI run at prod.

Destructive scenarios additionally require \`allow_destructive_tests\`, and
recordings are only ever written by \`pharos record\`. No secret value reaches
console output, reports, artifacts, or recordings: redaction (header names,
JSON paths, query params) is configured in \`pharos.config.json\`.

## Pitfall: \`follow_redirects\`

With the default \`follow_redirects: true\`, intermediate 30x hops are
**invisible** — \`fetch\` follows them internally and only the final response is
observed, so the cookie jar, comparison, and extraction never see them
(Section 9.3). A flow that must inspect a redirect, extract from it, or pick up
a cookie it sets has to walk the chain manually:

\`\`\`yaml
steps:
  - id: authorize
    request:
      method: GET
      path: /oauth2/authorize
      follow_redirects: false      # expose the 30x and its Location
    extract:
      next: { from: response.headers, path: location }
  - id: callback
    request:
      method: GET
      path: "{{ variables.next }}"  # replay the Location as the next hop
\`\`\`

This is the most common authoring mistake in cookie- and redirect-heavy flows
(OAuth authorize chains in particular).
`;
}

/**
 * The exact file set `init` writes, with paths relative to the scaffold root.
 * Ordering is stable so output and conflict listings are deterministic.
 */
export function scaffoldFiles(service: string = DEFAULT_SERVICE): ScaffoldFile[] {
  assertValidService(service);
  return [
    { path: 'package.json', contents: packageJsonTemplate(service) },
    { path: 'pharos.config.json', contents: configTemplate() },
    { path: `contracts/${service}.contract.yaml`, contents: contractTemplate(service) },
    { path: 'scenarios/smoke/health.yaml', contents: scenarioTemplate(service) },
    { path: 'hooks/index.ts', contents: hooksTemplate() },
    { path: '.gitignore', contents: gitignoreTemplate() },
    { path: 'README.md', contents: readmeTemplate(service) },
  ];
}

type PathKind = 'missing' | 'file' | 'directory';

/**
 * What is at `target` today. Errors other than "not there" (notably ENOTDIR,
 * raised when an ancestor is a file) are reported as `missing`: the ancestor
 * scan attributes those to the ancestor, which is where the fix belongs.
 */
function pathKind(target: string): PathKind {
  try {
    const stats = statSync(target, { throwIfNoEntry: false });
    if (!stats) return 'missing';
    return stats.isDirectory() ? 'directory' : 'file';
  } catch {
    return 'missing';
  }
}

/** Every directory the file set needs, from the root down, first-seen order, deduped. */
function requiredDirectories(files: ScaffoldFile[]): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const segments = file.path.split('/');
    segments.pop();
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      dirs.push(prefix);
    }
  }
  return dirs;
}

/**
 * Everything standing between the current tree and the file set. Checks the
 * *types* on disk, not just presence: `mkdirSync` and `writeFileSync` each fail
 * on a path occupied by the other kind, and discovering that mid-loop would
 * break the all-or-nothing guarantee (spec Section 19.2).
 */
export function findScaffoldConflicts(dir: string, files: ScaffoldFile[]): ScaffoldConflict[] {
  const conflicts: ScaffoldConflict[] = [];

  if (pathKind(dir) === 'file') {
    conflicts.push({
      path: '.',
      reason: 'the scaffold target itself exists as a file',
      fatal: true,
    });
    return conflicts;
  }

  for (const relative of requiredDirectories(files)) {
    if (pathKind(join(dir, relative)) === 'file') {
      conflicts.push({
        path: relative,
        reason: 'exists as a file, but the scaffold needs a directory here',
        fatal: true,
      });
    }
  }

  for (const file of files) {
    const kind = pathKind(join(dir, file.path));
    if (kind === 'directory') {
      conflicts.push({ path: file.path, reason: 'exists as a directory', fatal: true });
    } else if (kind === 'file') {
      conflicts.push({ path: file.path, reason: 'already exists', fatal: false });
    }
  }

  return conflicts;
}

/**
 * Write the scaffold into `dir` (spec Section 19.2). Scaffolding into an
 * existing, non-empty directory is fine — only a path the scaffold itself needs
 * is a conflict, and any conflict aborts the whole write before a single file is
 * touched, so a refused `init` never leaves a half-scaffold behind. `force`
 * overwrites stale files but never a path occupied by the wrong kind of entry:
 * `init` writes files, it does not delete trees.
 */
export function scaffoldProject(options: ScaffoldOptions = {}): ScaffoldResult {
  const dir = resolve(options.dir ?? process.cwd());
  const service = options.service ?? DEFAULT_SERVICE;
  const files = scaffoldFiles(service);

  const conflicts = findScaffoldConflicts(dir, files);
  const blocking = options.force ? conflicts.filter((conflict) => conflict.fatal) : conflicts;
  if (blocking.length > 0) {
    throw new ScaffoldConflictError(dir, blocking);
  }

  for (const file of files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.contents, 'utf8');
  }

  return {
    dir,
    service,
    written: files.map((file) => file.path),
    overwritten: conflicts.map((conflict) => conflict.path),
  };
}
