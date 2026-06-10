# Installation

Pharos is a [bun](https://bun.sh) project. Everything — installing
dependencies, running the CLI, and running the test suite — goes through bun.

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
