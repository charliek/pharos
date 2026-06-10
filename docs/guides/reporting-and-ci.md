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
- `allowedEnvironments` is honored against `output_mode`.

A skipped scenario imposes no base-URL requirement, so a guarded scenario does
not force config it never uses.

## In CI

Run Pharos like any other test gate. Separate live-comparison scenarios from
deterministic replay scenarios with tags, so CI can run the deterministic set
without a live legacy dependency. Recording updates are refused in CI by default.
