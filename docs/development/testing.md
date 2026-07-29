# Testing

Pharos tests itself with **Vitest** — the harness validates the framework
(schemas, comparison, normalization, hooks, recording, reporting, the CLI
wiring), exactly as the spec's Section 16 test plan prescribes.

```bash
bun run test            # vitest run
bun run test:watch      # watch mode
bun run test:coverage   # with v8 coverage
```

## What is covered

| Area | Tests |
|---|---|
| JSONPath subset | parse + reject out-of-subset; get/remove/transform. |
| Schemas | the scenario validation matrix and the contract schema. |
| Config | layered precedence; mode-aware validation; `environment`/`production_url_patterns` validation. |
| HTTP client | path/query/headers/body, JSON/text, timeout, never-throw, OPTIONS/HEAD, `form`, manual redirects, multi-`Set-Cookie` capture — against a local server. |
| Normalization | each transform; timestamp UTC + truncation; determinism. |
| Comparison | every strategy; missing/extra/type/value; the redaction guarantee; `set_cookie`/`location` dimensions; `expect` (`header_present`, `set_cookie_absent`, templated values). |
| Execution | end-to-end runs against mock servers; extraction; artifacts. |
| Cookies | per-target jar keying, (name, path) precedence, explicit `Cookie` header override. |
| Environment/safety | `environment` skip-vs-refuse behavior, `production_url_patterns` guard. |
| Hooks | setup/cleanup, before/after, cleanup-on-failure, unknown-hook. |
| Recording | redacted writes, path containment, replay, missing fixture. |
| Reporting | report summary, console/JSON/JUnit, no-secret-in-report. |
| Packaging & scaffolding | the public barrel's exported surface; `pharos init` idempotency and generated-tree validity. |
| Lockstep | the shared `tests/fixtures/lockstep/` fixture resolves identically through Pharos's own merge/comparison engine. |
| Examples | the shipped example scenarios run green against the mock service. |

## Test servers

HTTP-touching tests use a small `node:http` server helper (`tests/helpers`), so
they run identically under bun and node. The example tests start two instances of
the mock `user-service` (`examples/mock-service.ts`) as `legacy` and `new`.

## CI

`.github/workflows/ci.yml` runs `biome ci`, the type-check, the Vitest suite, and
`pharos validate` on every push and pull request, plus a separate
**`lockstep-twin`** job that byte-compares the shared lockstep fixture against
Limen main so the two engines can't drift apart silently (spec Section 13). A
`ci-success` gate requires both jobs before a PR is mergeable. The docs site
builds and deploys to GitHub Pages from `.github/workflows/docs.yml`.
