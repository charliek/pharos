# Development setup

## Toolchain

Pharos is a [bun](https://bun.sh) project, pinned to `1.3.13` via
[`.mise.toml`](https://github.com/charliek/pharos/blob/main/.mise.toml). With
[mise](https://mise.jdx.dev):

```bash
mise install        # provision the pinned bun
bun install         # install dependencies
```

## The quality gate

Run before every commit:

```bash
bun run typecheck   # tsc --noEmit
bun run lint        # biome check .
bun run test        # vitest run
```

`bun run check` runs all three; `mise exec -- make check` is the same via the
Makefile (`make help` lists every target). Lint and format are handled by
**Biome**; types are checked separately with `tsc` (Biome does not type-check).

## Running the example end to end

The repository ships a runnable example — a mock `user-service`, a contract, the
seven required scenarios, hooks, and a recording:

```bash
bun run example:serve &     # legacy on :3001, new on :3002
LEGACY_BASE_URL=http://127.0.0.1:3001 \
NEW_BASE_URL=http://127.0.0.1:3002 \
ALLOW_DESTRUCTIVE_TESTS=true \
  bun run ftest -- run
```

All seven scenarios pass; without `ALLOW_DESTRUCTIVE_TESTS` the destructive flow
is skipped.

## Conventions

- snake_case for on-disk contract/scenario field names (the vocabulary shared
  with Limen); camelCase for TypeScript identifiers.
- The supported JSONPath subset only: `$.field`, `$.nested.field`,
  `$.items[*].field` — in lockstep with Limen.
- Comments explain *why*, not *what*; match the surrounding code's idiom.

See `CLAUDE.md` for the full conventions.

## Documentation

The site builds with `mkdocs-material` via [uv](https://docs.astral.sh/uv/):

```bash
make docs-serve     # http://127.0.0.1:7072
make docs           # build into site-build/
```
