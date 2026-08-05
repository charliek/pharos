# Configuration

Configuration is layered, each source overriding the previous:

1. Built-in defaults
2. Config file (`pharos.config.json` / `.yaml` / `.yml`, auto-discovered or via `--config`)
3. Environment variables
4. CLI arguments

## Fields

| Field | Env | Default | Description |
|---|---|---|---|
| `legacy_base_url` | `LEGACY_BASE_URL` | — | Base URL of the legacy service. |
| `new_base_url` | `NEW_BASE_URL` | — | Base URL of the new service. |
| `scenario_dir` | `SCENARIO_DIR` | `./scenarios` | Where scenarios are discovered. |
| `contract_dir` | `CONTRACT_DIR` | `./contracts` | Where contracts are discovered. |
| `fixture_dir` | `FIXTURE_DIR` | `./fixtures/recordings` | Recording fixtures. |
| `report_dir` | `REPORT_DIR` | `./reports` | JSON/JUnit reports and artifacts. |
| `hooks_module` | — | `./hooks/index.ts` | Module exporting the hook registry. |
| `default_timeout_ms` | `DEFAULT_TIMEOUT_MS` | `10000` | Per-request timeout. |
| `default_headers` | — | `{}` | Headers added to every request. |
| `output_mode` | `PHAROS_MODE` | `local` | `local` or `ci`. Governs reporting/recording conventions only. |
| `environment` | `PHAROS_ENVIRONMENT` | `local` | `local`, `ci`, `staging`, or `production`. The safety-relevant environment `safety.allowedEnvironments` is compared against — independent of `output_mode`. See [Safety gates](../guides/reporting-and-ci.md#safety-gates). |
| `production_url_patterns` | — | `[]` | Host globs (e.g. `*.example.com`) matched against the lowercase hostname of each base URL. A match while `environment != production` aborts the run before any request. |
| `allow_destructive_tests` | `ALLOW_DESTRUCTIVE_TESTS` | `false` | Run destructive scenarios. |
| `allow_production_guard_override` | `ALLOW_PRODUCTION_GUARD_OVERRIDE` | `false` | Run scenarios requiring the production guard. |
| `allow_recording_updates` | `ALLOW_RECORDING_UPDATES` | `false` | Allow recording writes (refused in CI without it). |
| `redaction` | — | see below | Header names, JSON paths, and query params to mask in output. |

## Example config file

```json
{
  "scenario_dir": "./scenarios",
  "contract_dir": "./contracts",
  "hooks_module": "./hooks/index.ts",
  "redaction": {
    "headers": ["authorization", "cookie", "set-cookie", "x-api-key"],
    "json_paths": ["$.email"],
    "query_params": ["access_token"]
  }
}
```

`redaction.json_paths` augment the contract's `redact_paths` at run time, so an
operator-declared secret is masked in the diff, the reports, and the artifacts
even if the contract author did not redact it.

## Mode-aware validation

Before a run, Pharos asserts the configuration carries what the selected modes
need (a `compare_live` scenario needs both base URLs, `replay_against_recording`
needs `new_base_url` and `fixture_dir`, and so on) and fails fast with an
actionable error rather than a confusing network failure mid-run.
