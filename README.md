# Pharos

[![CI](https://github.com/charliek/pharos/actions/workflows/ci.yml/badge.svg)](https://github.com/charliek/pharos/actions/workflows/ci.yml)
[![Docs](https://github.com/charliek/pharos/actions/workflows/docs.yml/badge.svg)](https://github.com/charliek/pharos/actions/workflows/docs.yml)

**A black-box functional test suite that validates a new service against a
legacy one — deterministically, from the outside — before and during a
migration.**

> *Pharos* was the great lighthouse of Alexandria: the fixed reference that let
> ships verify their position and cross safely. Pharos the test suite is the
> fixed, deterministic reference against which a new service's behavior is
> checked before it carries real traffic.

```
            ┌──────────────── pharos ────────────────┐
  scenario  │                                         │───▶  legacy  (reference)
  (YAML) ──▶│  resolve vars → request → normalize      │
            │     │                                     │───▶  new     (the rewrite)
            │     └─ compare per contract ── diff ──────│
            └─────────────────────────────────────────-┘
                 pass / fail · readable diffs · CI artifacts
```

Pharos treats both systems as black-box HTTP APIs. It issues the same request to
`legacy` and `new`, normalizes the responses with a shared
[behavioral contract](docs/pharos_spec.md), and compares them — turning "does
the rewrite behave like the original?" into a test that passes or fails. It can:

- **Compare live** — call both services and diff the responses semantically,
  ignoring incidental differences (request IDs, timestamps, key order) declared
  in the contract.
- **Record & replay** — capture known-good legacy interactions and replay them
  against the new service when legacy is unavailable or deterministic replay is
  wanted.
- **Assert new-only** — drive the new service alone and check explicit
  expectations, for intentionally changed or net-new behavior.
- **Refine the contract** — catch over-normalization (hiding a real difference)
  and under-normalization (false failures on dynamic fields), tightening the
  rules that [Limen](docs/limen_spec.md) then consumes against production traffic.

Pharos is the **pre-production** half of a two-tool migration approach; the
[Limen](docs/limen_spec.md) migration proxy is the runtime half. The two share a
behavioral contract — a portable YAML/JSON description of what to compare and
which incidental differences don't count — but have **no build-time dependency**
on each other.

## Status

Pharos implements the full MVP from the [specification](docs/pharos_spec.md)
(Section 14): scenario and contract loading and validation, the HTTP client
(including a per-target cookie jar, manual redirects, and form bodies), the
comparison and normalization engine (including the `set_cookie`/`location`
dimensions and the one-sided `expect` vocabulary), all five comparison
strategies, the four execution modes, hooks, recording and replay, the
console/JSON/JUnit reporters, CLI filtering, exit codes, the `environment`
safety model, and packaging/scaffolding (Section 19: `pharos init`, consumed as
a pinned git dependency) — plus a runnable example service with the seven
required scenarios. See `CLAUDE.md` for conventions.

## Requirements

- [bun](https://bun.sh) — runtime, package manager, and task runner. Pinned to
  `1.3.13` via [`.mise.toml`](.mise.toml); with [mise](https://mise.jdx.dev)
  installed, `mise install` provisions it.

## Quickstart

```bash
mise install                 # install the pinned bun toolchain (or use your own)
bun install                  # install dependencies
bun run check                # typecheck + lint + tests — the full quality gate
```

Run the CLI through the `ftest` script — five subcommands: `run`, `validate`,
`record`, `check-contract`, and `init` (see the
[CLI reference](docs/reference/cli.md) for the full list):

```bash
bun run ftest -- --help
bun run ftest -- validate                 # validate the example scenarios + contract
bun run ftest -- check-contract contracts/user-service.contract.yaml
```

### Try the example end to end

The repo ships a runnable example — a mock `user-service`, a contract, the seven
required scenarios, hooks, and a recording. Bring up two mock instances and run:

```bash
bun run example:serve &                    # legacy on :3001, new on :3002
LEGACY_BASE_URL=http://127.0.0.1:3001 \
NEW_BASE_URL=http://127.0.0.1:3002 \
ALLOW_DESTRUCTIVE_TESTS=true \
  bun run ftest -- run
```

All seven scenarios pass; without `ALLOW_DESTRUCTIVE_TESTS` the destructive flow
is skipped. Reports land in `reports/` (`report.json`, `junit.xml`).

## Using Pharos in a service

A service under migration consumes Pharos as a **bun git dependency pinned to a
commit** (`github:charliek/pharos#<sha>`) — never a published npm package. The
public import surface is `src/index.ts` (hook/config/scenario/contract types);
everything else under `src/` is internal. `pharos init [dir]` scaffolds a
runnable conformance tree — config, a stub contract, an example scenario, a
hook registry stub, and a README — into a target repo in one step; see the
[`init` reference](docs/reference/cli.md#init).

## Development

The quality gate (run before every commit):

```bash
bun run typecheck            # tsc --noEmit
bun run lint                 # biome check .
bun run test                 # vitest run
```

`bun run check` runs all three; `mise exec -- make check` is the same via the
Makefile (`make help` lists every target). CI runs `biome ci`, the typecheck,
and the Vitest suite on every push and PR.

## Documentation

The full site lives under `docs/` and builds with [Zensical](https://zensical.org)
(`make docs-serve` → http://127.0.0.1:7072):

- **Getting started** — installation, quickstart
- **Guides** — writing scenarios, comparison & contracts, variables & hooks,
  recording & replay, reporting & CI
- **Reference** — architecture, CLI, scenario format, contract, configuration
- **Specifications** — the full Pharos spec, the migration runbook, the PR/FAQ,
  and the companion Limen spec

`CLAUDE.md` captures the project conventions for contributors and coding agents.

## License

MIT — see [LICENSE](LICENSE).
