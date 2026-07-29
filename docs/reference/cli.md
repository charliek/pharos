# CLI

Pharos exposes five subcommands, reached through the `ftest` script
(`bun run ftest -- <command>`) or the `pharos` bin.

| Command | Purpose |
|---|---|
| `run` | Run scenarios and compare the new service against legacy. |
| `validate` | Validate scenarios and contracts without running them. |
| `record` | Record legacy interactions into fixtures (explicit opt-in). |
| `check-contract` | Validate a behavioral contract and its JSONPath compliance. |
| `init` | Scaffold a conformance directory into a target repo. |

Configuration is layered (defaults < config file < environment < CLI flags); see
the [configuration reference](configuration.md).

## `run`

```bash
bun run ftest -- run [--config <path>] [--scenario <id>] \
  [--include-tag <tag>...] [--exclude-tag <tag>...]
```

Discovers scenarios under `scenario_dir`, applies the filters and safety gates,
runs each, and prints a console report. It also writes `report.json` and
`junit.xml` to `report_dir`. Exits non-zero when any required scenario fails;
skipped scenarios are reported separately and do not fail the run.

| Option | Description |
|---|---|
| `-c, --config <path>` | Config file path (otherwise auto-discovered). |
| `-s, --scenario <id>` | Run a single scenario by id. |
| `--include-tag <tag...>` | Only run scenarios carrying any of these tags. |
| `--exclude-tag <tag...>` | Skip scenarios carrying any of these tags. |

`compare_live` and `legacy_record` need `legacy_base_url`; `compare_live`,
`new_only_assert`, and `replay_against_recording` need `new_base_url`. A missing
base URL for a selected mode fails fast with an actionable message.

## `validate`

```bash
bun run ftest -- validate [--config <path>] \
  [--scenario-dir <path>] [--contract-dir <path>]
```

Semantically validates every scenario and contract: required fields, known enum
values, the supported JSONPath subset, resolvable contract references, the
scenario/contract service match, and the contract-vs-inline conflict rule.
Failures name the file **and** the field path. Exits non-zero on any error.

## `record`

```bash
bun run ftest -- record [--config <path>] [--scenario <id>]
```

Runs `legacy_record` scenarios with recording **enabled**, writing redacted
fixtures under `fixture_dir`. This is the explicit opt-in that allows recordings
to be written; it is refused in CI by default unless `ALLOW_RECORDING_UPDATES=true`.

## `check-contract`

```bash
bun run ftest -- check-contract <path>
```

Validates a contract file (YAML or JSON) against the schema and confirms every
JSONPath is within the [supported subset](contract-reference.md#supported-jsonpath-subset).
It produces the **same** verdict Limen's `check-contract` would, so a contract
can be confirmed consumable by both tools before it is wired into scenarios or
proxy routes.

## `init`

```bash
bun run ftest -- init [dir] [--service <name>] [--force]
```

Scaffolds a runnable conformance directory into `dir` (default: the current
directory) — the starting point for a target repo that consumes Pharos as a
pinned git dependency. It writes:

| File | Contents |
|---|---|
| `package.json` | Minimal package: `conformance`/`validate`/`record` scripts and a **placeholder** `pharos` git dependency to pin. |
| `pharos.config.json` | The standard directory layout, `hooks_module`, `environment: local`, and the redaction defaults. |
| `contracts/<service>.contract.yaml` | Stub contract with one `health` route. |
| `scenarios/smoke/health.yaml` | Example `new_only_assert` scenario referencing that route. |
| `hooks/index.ts` | Hook registry stub importing its types from the `pharos` **package name**. |
| `.gitignore` | Ignores `reports/` and `fixtures/recordings/`. |
| `README.md` | How to install, run, and reason about the safety model. |

| Option | Description |
|---|---|
| `--service <name>` | Service name used in the contract, the scenario, the contract filename, and the package name. Lowercase slug; defaults to `my-service`. |
| `--force` | Overwrite existing files instead of refusing. |

The generated tree passes `validate` unmodified. `init` is idempotent: if any
path it needs is occupied, it names every conflict, writes **nothing**, and exits
non-zero — `--force` overwrites existing files. Occupation is judged by type: a
directory the scaffold needs that exists as a file, or a generated file path that
exists as a directory, is refused even with `--force` (resolving it needs a
delete, which `init` never does). Scaffolding into an existing, non-empty
directory is fine as long as nothing the scaffold needs collides.

Because Pharos resolves its config and directories relative to the current
working directory, the generated suite must be run from the scaffold root — see
its README.
