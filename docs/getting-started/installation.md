# Installation

Pharos is a [bun](https://bun.sh) project. Everything — installing
dependencies, running the CLI, and running the test suite — goes through bun.

This page covers cloning Pharos itself, for contributors. If you want to add a
Pharos conformance suite to a **target repo** instead, skip to
[Consuming Pharos in a target repo](#consuming-pharos-in-a-target-repo) below.

## Toolchain

The bun version is pinned to `1.3.13` in [`.mise.toml`](https://github.com/charliek/pharos/blob/main/.mise.toml).
With [mise](https://mise.jdx.dev) installed, it reads that file and provisions
the exact version:

```bash
mise install            # install the pinned bun toolchain
```

If you manage bun yourself, any `bun >= 1.3.0` works; the pin only guarantees
everyone (and CI) uses the same version.

## Install dependencies

```bash
bun install             # or: mise exec -- bun install
```

This installs the runtime dependencies (`commander`, `fast-glob`, `yaml`,
`zod`) and the dev toolchain (Vitest, Biome, TypeScript).

## Verify the install

Run the full quality gate — type-check, lint, and the Vitest harness suite:

```bash
bun run check
```

Or each step individually:

```bash
bun run typecheck       # tsc --noEmit
bun run lint            # biome check .
bun run test            # vitest run
```

You can also drive the CLI directly:

```bash
bun run ftest -- --help
```

## Consuming Pharos in a target repo

The instructions above set up **this** repository for development. A service
being migrated instead consumes Pharos as a **bun git dependency pinned to a
commit** (`github:charliek/pharos#<sha>`) — never a published npm package or a
floating branch ref (spec Section 19.1). The `pharos init` command scaffolds
that dependency and a runnable conformance tree in one step, run against a
target directory (default: the current directory):

```bash
bunx github:charliek/pharos#<sha> init [dir] --service <name>
```

`init` writes `package.json` (with a **placeholder** SHA you must replace),
`pharos.config.json`, a stub contract and example scenario, `hooks/index.ts`,
`.gitignore`, and a README covering the safety model — see the
[`init` reference](../reference/cli.md#init) for the full file list and the
conflict/idempotency rules. Because Pharos resolves its config relative to the
current working directory, the scaffolded suite must be run from the scaffold
root.

## Documentation site (optional)

The documentation you are reading builds with `mkdocs-material`, managed with
[uv](https://docs.astral.sh/uv/):

```bash
make docs-serve         # serve locally at http://127.0.0.1:7072
make docs               # build the static site into site-build/
```

## Next steps

- [Quickstart](quickstart.md) — write a scenario and run a comparison.
- [Pharos specification](../pharos_spec.md) — the full design.
