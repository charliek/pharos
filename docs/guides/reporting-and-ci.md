# Reporting & CI

## Output surfaces

A `run` produces three things:

- **Console** — pass/fail/skip per scenario, with per-step mismatches and diffs
  for failures, plus a summary line.
- **`report.json`** — the machine-readable [run report](#run-report), written to
  `report_dir`.
- **`junit.xml`** — a JUnit report for CI-native integration.

On a failed comparison, Pharos also writes **redacted artifacts** under
`report_dir/artifacts/<scenario-id>/<step-id>/`: `request.json`,
`legacy-response.json`, `new-response.json`, and `diff.txt`. Every surface is
redacted — no secret reaches disk.

## Run report

```json
{
  "startedAt": "...", "finishedAt": "...", "durationMs": 0,
  "summary": { "total": 7, "passed": 6, "failed": 0, "skipped": 1 },
  "scenarios": [ { "scenarioId": "...", "pass": true, "steps": [ ... ] } ]
}
```

The report deliberately omits the raw legacy/new responses; only the
already-redacted comparison summary, mismatches, and diff text are included, so
neither the JSON nor the JUnit report can leak a secret.

## Exit codes

`run` exits **non-zero** when any required scenario fails, and **zero** when all
selected required scenarios pass. Skipped scenarios are reported separately and
never fail the run on their own — so a CI gate is simply:

```bash
bun run ftest -- run --include-tag migration-ready
```

## Safety gates

Scenarios may be skipped (not failed) by a safety gate:

- **Destructive** scenarios run only with `ALLOW_DESTRUCTIVE_TESTS=true`.
- Scenarios with `requiresProductionGuardOverride` need
  `ALLOW_PRODUCTION_GUARD_OVERRIDE=true`.
- `allowedEnvironments` is honored against the config's `environment` field
  (`local`/`ci`/`staging`/`production`, default `local`) — **not**
  `output_mode`, which governs reporting/recording conventions only.

A skipped scenario imposes no base-URL requirement, so a guarded scenario does
not force config it never uses. A skip counts only under the `skipped`
summary counter — never `passed` — and never fails the run by itself.

### `environment: production` is fail-closed

Outside `environment: production`, an environment mismatch is a skip as
above. In `environment: production`, the same mismatch is a **refusal**
instead: a scenario runs only if `safety.allowedEnvironments` explicitly
includes `production`; every other scenario becomes a distinct **failing**
result (`pass: false`, `skipped: false`, a rendered reason) that contributes
to a non-zero exit code — refusals never skip, skips never fail. Tag a
scenario with the full environment list
(`allowedEnvironments: [local, ci, staging, production]`) if it is genuinely
safe everywhere; tagging it `[production]` alone makes it skip (not fail)
everywhere else. The destructive opt-in and production guard override above
still apply on top of the refusal check — the gates compose.

### `production_url_patterns`

`production_url_patterns` (config, e.g. `["*.example.com"]`) guards against
pointing a non-production run at a production host: if any configured base
URL's lowercase hostname matches a pattern while `environment != production`,
`run`/`record` abort with a config error before any request is issued.
`validate` never sends a request, so the guard doesn't apply there.

## In CI

Run Pharos like any other test gate. Separate live-comparison scenarios from
deterministic replay scenarios with tags, so CI can run the deterministic set
without a live legacy dependency. Recording updates are refused in CI by default.
