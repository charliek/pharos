# CLAUDE.md — Pharos project conventions

Conventions and context for working in this repository (for contributors and
coding agents). Read this before making changes.

## What Pharos is

A black-box functional test suite (TypeScript) that validates a **new** service
against a **legacy** one during migration: it issues HTTP requests to both,
normalizes and compares the responses against a shared behavioral contract, and
reports differences deterministically in local dev and CI. The authoritative
design is `docs/pharos_spec.md` (Section numbers referenced throughout the code
refer to it). `docs/runbook.md` and `docs/prfaq.md` give operational and
motivational context; `docs/limen_spec.md` describes the companion migration
proxy that **consumes** the same behavioral contract Pharos refines.

## Toolchain

- Runtime + package manager is **bun**, pinned to **1.3.13** via `.mise.toml`.
  Reach it through mise: `mise exec -- bun …` (or `mise exec -- make …`).
- Test runner is **Vitest** (spec requirement), launched by bun. The config
  uses `pool: 'forks'` because worker threads can be flaky under bun.
- Lint + format is **Biome**; types are checked separately with `tsc --noEmit`
  (Biome does not type-check).
- Docs tooling is Python via `uv` (`pyproject.toml`, `zensical` + the shared
  [stridelabs-docs-theme](https://github.com/charliek/stridelabs-docs-theme)
  package, pinned by tag). Not part of the Rust/TS gates.

## Quality gate (run before every commit)

```bash
bun run typecheck                 # tsc --noEmit
bun run lint                      # biome check .
bun run test                      # vitest run
```

`bun run check` runs all three together; `mise exec -- make check` is the same.
CI (`.github/workflows/ci.yml`) enforces `biome ci`, typecheck, and tests.

## Architecture (one screen)

- **Library + thin CLI.** All logic lives in `src/` modules; `src/cli/index.ts`
  only parses argv and dispatches. This keeps the harness testable without
  spawning processes or binding sockets.
- **Two artifacts** (spec Section 3.2): *scenario specs* (the executable layer —
  requests, steps, modes) and the *behavioral contract* (the shared comparison
  truth — what to normalize/ignore/redact). A scenario references a contract by
  `path#routeId`, exactly as a Limen route does, so the **same file** is portable
  between the two tools.
- **Module map** mirrors `docs/pharos_spec.md` Section 3.5:
  `cli` · `config` · `contract` · `scenarios` · `execution` · `comparison` ·
  `reporting`, plus two top-level, non-CLI files: `src/index.ts` (the public
  barrel a consuming repo's git dependency imports, Section 19.1) and
  `src/scaffold.ts` (the `init` template generation behind `cli/init.ts`,
  Section 19.2). Submodules are added in the phase that implements them rather
  than created empty up front. Recent additions worth knowing about:
  `execution/cookies.ts` (per-target cookie jar, Section 9.5),
  `comparison/headers.ts` (Set-Cookie/Location parsing + two-sided comparison,
  Section 8.6), and `comparison/expectations.ts` (the one-sided `expect`
  vocabulary, Section 4.7).

## Load-bearing invariants

These are the point of the project — never regress them:

1. **One normalization vocabulary, one JSONPath subset** shared with Limen
   (spec Section 8.4): `$.field`, `$.nested.field`, `$.items[*].field`. Anything
   else is a load-time validation error and must stay in lockstep with Limen.
   The shared fixture in `tests/fixtures/lockstep/` is a **byte-identical
   twin** of Limen's copy — never hand-edit it out of sync with Limen, and
   don't be surprised when CI's `lockstep-twin` job fails a PR that touches
   merge/comparison semantics without a matching Limen-side update.
2. **No secret value appears in any output** — redaction (header names, JSON
   paths, query params) applies to console output, JSON/JUnit reports, failure
   artifacts, and recordings. A test proves it (spec Section 16).
3. **Destructive scenarios require explicit opt-in**; production-like runs need
   an additional guard override. Recording updates require opt-in and are
   refused in CI by default.
4. **Cleanup hooks always run**, even when a step fails.
5. **Clear, actionable errors** name the file and field path (scenarios) or the
   route (contracts). Correctness and good error messages come first.
6. **Deterministic output.** Normalization and comparison must be order- and
   environment-independent.

## Behavioral contract vs. scenario/operational config

The shared contract owns *what to compare and how* (`ignore_paths`,
`redact_paths`, `sort_arrays`, `unordered_arrays`, `normalize_timestamps`,
`enum_aliases`, `compare_status`, `compare_body`, `compare_headers`). Scenarios
own structure, steps, hooks, modes, and recording fixtures; Pharos config owns
base URLs, directories, timeouts, and safety toggles. A scenario references a
contract **or** declares inline behavioral rules in the same vocabulary, never
both (validation error).

## Conventions

- snake_case for contract/scenario field names (`ignore_paths`, `sort_arrays`)
  — it is the portable on-disk vocabulary shared with Limen. TypeScript
  identifiers are camelCase as usual.
- Validate with `zod`; surface errors with file + field path.
- Match the surrounding code's comment density and idiom; comments explain
  *why*, not *what*.
- Biome style: single quotes, 2-space indent, 100-col width, semicolons,
  trailing commas.

## Commits

The build proceeds phase by phase (spec Section 14). Each phase: implement →
quality gate green → `/simplify` → `/codex:rescue` review → quality gate green
→ commit to `main`. Keep commits scoped to a phase or a coherent slice of one.
