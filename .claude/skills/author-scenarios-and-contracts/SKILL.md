---
name: author-scenarios-and-contracts
description: Use when authoring or refining Pharos scenarios and the shared behavioral contract for a legacy-vs-new service migration — writing scenario YAML, picking modes and comparison strategies, declaring normalization rules, and validating/running the suite.
---

# Authoring Pharos scenarios and contracts

Pharos issues the same HTTP requests to a **legacy** and a **new** service, normalizes both
responses, compares them, and reports differences deterministically. You author two artifacts:

- **Scenario specs** (`scenarios/**/*.yaml`) — the executable layer: requests, steps, modes.
- **The behavioral contract** (`contracts/<service>.contract.yaml`) — the shared comparison
  truth: what to ignore, redact, sort, normalize. Limen (the migration proxy) consumes the
  **same file** unchanged, so keep it free of operational concerns.

This skill is a map plus the commands; the reference is <https://charliek.github.io/pharos/> —
open the linked page rather than restating it from memory.

## Commands

From the **pharos checkout** (`bun run ftest -- <cmd>` runs the CLI in-tree):

```bash
bun run ftest -- validate                    # schema, JSONPath subset, contract refs — no requests
bun run ftest -- check-contract contracts/user-service.contract.yaml
bun run example:serve &                      # example mocks: legacy :3001, new :3002
export LEGACY_BASE_URL=http://127.0.0.1:3001 NEW_BASE_URL=http://127.0.0.1:3002
bun run ftest -- run --include-tag migration-ready     # also: --exclude-tag <tag...>
bun run ftest -- run -s users.session-login-profile    # -s/--scenario: one scenario by id
bun run ftest -- run -c ./pharos.config.json           # -c/--config: explicit config path
bun run ftest -- record                      # -s <id> narrows; legacy_record scenarios only
bun run ftest -- init ../some-repo/conformance --service my-service
```

From a **consuming repo** scaffolded by `init` (run from the scaffold root — config and every
directory in it resolve against the cwd):

```bash
bun run validate
bun run conformance -- --include-tag smoke                    # `conformance` is `pharos run`
bun run record                                                # same flags as above apply
bunx pharos check-contract contracts/my-service.contract.yaml # the bin, once installed
```

**Exit codes are 0 or 1 — there is no richer table.** `run` exits 1 when any scenario failed
(or on a config/validation error), 0 otherwise; skips are reported separately and never fail a
run, while production **refusals** do. `validate`/`check-contract` exit 1 on any invalid file.
[reference/cli](https://charliek.github.io/pharos/reference/cli/) ·
[guides/reporting-and-ci](https://charliek.github.io/pharos/guides/reporting-and-ci/).

## Scenario anatomy

`version: 1`, a dot/slash/dash lowercase `id` (`users.get-user-success`), `name`, `service`,
at least one `tags` entry, a `mode`, and `steps`. Each step has an `id`, a `request`
(`method`, `path`, optional `query`/`headers`/`body`/`form`/`follow_redirects`/`timeoutMs`),
and usually a `compare` block. Optional: `variables`, `setup`/`cleanup`/`before`/`after`
hooks, `extract`, `recording`, `safety`, `cookies`. Unknown keys are a load error.

**Modes** (four): `compare_live` (both services — the default path for reads),
`new_only_assert` (new only; strategy must be `explicit_expectations` or `custom`),
`replay_against_recording` (new vs. a recorded legacy fixture), `legacy_record` (capture
legacy; needs a `recording` fixture per step).

**Strategies** (five): `json_semantic` (default for JSON APIs), `exact`, `subset` (requires
`compare.body.require_matching_paths`), `explicit_expectations` (requires `compare.expect`),
`custom` (requires a named `comparator` hook).
[guides/scenarios](https://charliek.github.io/pharos/guides/scenarios/) ·
[reference/scenario-reference](https://charliek.github.io/pharos/reference/scenario-reference/).

## Contract reference **or** inline rules — never both

A scenario binds to one source of behavioral truth: either
`contract: "../../contracts/user-service.contract.yaml#login"` (`path#routeId`, exactly as a
Limen route names one) **or** inline behavioral rules on a step's `compare` block. Declaring
both is a validation error naming the file and the field path. Prefer the contract — it is the
artifact Limen reuses and the one a reviewer reads; inline is for a one-off no route owns.

Behavioral (contract-owned): `compare_status`, `compare_body`, `compare_headers`, and under
`json` — `ignore_paths`, `redact_paths`, `sort_arrays`, `unordered_arrays`,
`normalize_timestamps`, `enum_aliases` — plus the `set_cookie` and `location` dimensions. Any
of those on a step's `compare` (as `body.*`, `headers.compare`/`headers.ignore`, `set_cookie`,
`location`) is an inline behavioral rule and conflicts with `contract:`. Structural, and
always fine beside a contract: `strategy`, `status: same`, `require_matching_paths`, `expect`,
`comparator`.

## Shared vocabulary essentials

One JSONPath subset, shared byte-for-byte with Limen: `$.field`, `$.nested.field`,
`$.items[*].field`. Anything else fails at load time.

| Rule | Use it for |
|---|---|
| `ignore_paths` | Per-request non-determinism (request ids, server "now"). |
| `redact_paths` | PII/secrets — the value never reaches a diff, report, or artifact. |
| `sort_arrays` (`path` + `key`) | Collections whose order is incidental. |
| `normalize_timestamps` (`path` + `precision`) | Formatting drift between implementations. |
| `set_cookie` (`compare_values: presence`, `ignore_attributes`) | Session cookies each side mints independently. |
| `location` (`origin: ignore`) | Redirects, when legacy and new sit on different origins. |

Every rule is a deliberate exception to "compare everything" — keep each narrow and comment
*why*. Full list:
[reference/contract-reference](https://charliek.github.io/pharos/reference/contract-reference/),
[guides/comparison-and-contracts](https://charliek.github.io/pharos/guides/comparison-and-contracts/).

Set `cookies: true` on a scenario for the **per-target cookie jar**: a `Set-Cookie` is carried
into that target's later steps automatically, so a login step's session reaches the profile
step without manual extraction. Without it, the scenario must propagate cookies itself.

## The identical-failure trap — when to use one-sided `expect`

Two-sided agreement (`strategy: json_semantic`, `status: same`) passes when **both** sides fail
the same way: a broken cookie jar returning 401 from legacy *and* new is a green step that
proves nothing. On any step where "the same" is not enough, use
`strategy: explicit_expectations` and pin the truth one-sided:

```yaml
compare:
  strategy: explicit_expectations
  expect:
    status: 200
    body:
      json_paths:
        $.authenticated: true
```

`expect` accepts `status`, `body.json_paths`, `headers`, `header_present`, `header_absent`,
`set_cookie`, `set_cookie_absent`, `location`; at least one must assert something. Naming
`set-cookie`/`cookie` in the header maps is a validation error — use `set_cookie` /
`set_cookie_absent`, which read the lossless capture. Reach for `expect` on the auth state a
flow depends on, on redirect targets, and always in `new_only_assert` (no second side exists).

## Safety gates

- `safety.destructive: true` on any scenario that writes or deletes; it runs only with
  `ALLOW_DESTRUCTIVE_TESTS=true`, otherwise it is **skipped** (never a failure).
- `safety.allowedEnvironments: [local, ci, staging]` is checked against the config's
  `environment` (`local`|`ci`|`staging`|`production`, env var `PHAROS_ENVIRONMENT`): outside
  production a mismatch skips, but **in `environment: production` it is a refusal that fails**
  (fail-closed). `safety.requiresProductionGuardOverride: true` additionally demands
  `ALLOW_PRODUCTION_GUARD_OVERRIDE=true`.
- `production_url_patterns` in the config (e.g. `["*.example.com"]`) aborts `run`/`record` with
  a config error before any request if a base URL's host matches while `environment !=
  production`.
- Recording is opt-in: only `record` writes fixtures, and it is **refused in CI**
  (`output_mode: ci`, i.e. `PHAROS_MODE=ci`) unless `ALLOW_RECORDING_UPDATES=true` —
  [guides/recording-and-replay](https://charliek.github.io/pharos/guides/recording-and-replay/).

## Streaming and SSE are out of scope

Do not write a scenario against a server-sent-events or chunked streaming endpoint. The HTTP
client reads the full body before producing a response record, so an unending body yields only
Pharos's own timeout record — a scope boundary, not a gap awaiting a mode. Cover the handshake,
subscription, and status routes around the stream as ordinary request/response scenarios; live
streams belong to Limen's relay/observe side.
[Spec Appendix A](https://charliek.github.io/pharos/pharos_spec/#appendix-a-streaming-and-sse-endpoints-are-out-of-scope).

## Scaffolding a consuming repo

Pharos is consumed as a **bun git dependency pinned to a commit** — never a published npm
package, never a floating branch ref:

```bash
bunx github:charliek/pharos#<commit-sha> init . --service my-service
```

That writes `package.json` (scripts `conformance`/`validate`/`record` plus a placeholder
`"pharos": "github:charliek/pharos#REPLACE_WITH_PINNED_COMMIT_SHA"`), `pharos.config.json`, a
stub contract, an example `new_only_assert` scenario, `hooks/index.ts`, `.gitignore`, and a
README. Replace the placeholder with a real SHA, `bun install`, then `bun run validate` — the
generated tree passes unmodified. `init` refuses to clobber (`--force` overwrites files); only
`src/index.ts` is public import surface.
[reference/cli#init](https://charliek.github.io/pharos/reference/cli/#init) ·
[reference/configuration](https://charliek.github.io/pharos/reference/configuration/).

## Worked examples to copy from (in the pharos checkout)

- `scenarios/users/session-login-profile.yaml` — `cookies: true` jar, a two-sided `set_cookie`
  comparison through the contract's `login` route, and a profile step pinned with
  `expect.status: 200` precisely because a shared 401 would otherwise pass.
- `scenarios/users/find-user-redirect.yaml` — a 303 with `follow_redirects: false`, compared
  two-sided via the contract's `location.origin: ignore`, then asserted one-sided with
  `expect.location.path`.
- `scenarios/users/create-then-fetch-destructive.yaml` — `safety.destructive`, hooks,
  `extract`, `subset`. `contracts/user-service.contract.yaml` — every rule above, with reasons.

Finish by running `validate`, `check-contract` on any contract you touched, and `run` against
the mocks or the real pair. Inside the pharos repo the gate is `bun run check` (typecheck,
lint, tests) — `mise exec -- make check` is the same.
