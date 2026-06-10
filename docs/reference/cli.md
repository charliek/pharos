# CLI

Pharos exposes four subcommands, reached through the `ftest` script
(`bun run ftest -- <command>`) or the `pharos` bin.

| Command | Purpose |
|---|---|
| `run` | Run scenarios and compare the new service against legacy. |
| `validate` | Validate scenarios and contracts without running them. |
| `record` | Record legacy interactions into fixtures (explicit opt-in). |
| `check-contract` | Validate a behavioral contract and its JSONPath compliance. |

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
