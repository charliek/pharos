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
  "summary": {
    "total": 7, "passed": 6, "failed": 0, "skipped": 1,
    "discovered": 8, "executed": 7, "filtered": 1, "parseFailed": 0, "refused": 0,
    "narrowed": ["--exclude-tag jwt"],
    "floor": { "minScenarios": 1, "executed": 7, "applied": 1, "met": true }
  },
  "scenarios": [ { "scenarioId": "...", "pass": true, "steps": [ ... ] } ]
}
```

`discovered` is the file count fast-glob found under `scenario_dir` — the
run's real denominator, independent of whatever survived filtering.
`filtered` is everything dropped by mode or `--scenario`/`--include-tag`/
`--exclude-tag` filtering; `parseFailed` and `refused` are reported (failing)
results that never ran; `executed` is what actually ran — the floor's
numerator. `narrowed` lists the explicit CLI narrowing in effect. `floor` is
the run's [scenario-floor](#exit-codes) verdict. Every discovered file gets
exactly one of these classifications, and `discovered` always equals their
sum — a tool bug (not a bad run) if it doesn't.

The report deliberately omits the raw legacy/new responses; only the
already-redacted comparison summary, mismatches, and diff text are included, so
neither the JSON nor the JUnit report can leak a secret.

## Exit codes

| Exit | Meaning |
|---|---|
| `0` | All selected required scenarios passed, and the run's scenario floor was met. |
| `1` | At least one required scenario failed (a production refusal counts as a failure here). |
| `20` | The run's scenario floor (`min_scenarios`) was not met — insufficient evidence, regardless of whether anything also failed. |

Precedence is **20 > 1 > 0**: insufficient evidence makes a lower finding
incomplete, so a floor miss outranks a scenario failure even when scenarios
also failed. `20` is the same number limen uses for the same idea, so a
wrapper driving both tools carries one vocabulary. `record` shares this table
and evaluator, against its own floor — see
[`record` has its own floor](#record-has-its-own-floor) below.

The floor (`min_scenarios` — config field, `MIN_SCENARIOS` env, or
`--min-scenarios <n>`; default `1`) is evaluated on `summary.executed`, never
`passed + failed`: a parse failure or a production refusal is a reported
result, not evidence that a scenario ran, so neither can prop up the
numerator. Executing zero scenarios is unconditionally a failure, whatever the
floor is set to.

Skipped scenarios are reported separately and never fail the run on their
own — so a CI gate is simply:

```bash
bun run ftest -- run --include-tag migration-ready
```

**This gate keeps its configured floor.** Narrowing the suite with
`--include-tag`/`--exclude-tag` (or a mode filter) does not suspend the
scenario floor — `min_scenarios` still applies to the narrowed set. That is
deliberate: a renamed or emptied tag must not silently shrink `migration-ready`
from 70 scenarios to 3, or to 0, and still exit 0. Set `min_scenarios` (or
pass `--min-scenarios`) to the count you actually expect this gate to select.

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

## `record` has its own floor

`record` always narrows a run to `legacy_record` scenarios, so every other
scenario in the corpus lands in `filtered` by construction and can never be
`executed`. That narrowing is the command's definition, not an operator's
filter — unlike a tag or mode filter someone chose, it cannot drift — so the
rule above ("narrowing keeps the configured floor") does not apply to it.
`record` instead evaluates against its own floor of **at most 1**
(`min(min_scenarios, 1)`): a repository gating CI at `min_scenarios: 20` does
not get exit 20 from every `pharos record` just because the corpus has fewer
than 20 `legacy_record` scenarios. Recording nothing at all is still exit 20
(rule 1 above still applies), and a named `--scenario` still has to execute
(rule 2). An operator who wants a specific size assertion on a recording run
states it explicitly with `--min-scenarios <n>`, which `record` honors
verbatim.

## What a complete run needs

Pharos has no `pharos doctor` and does not preflight the environment. A
missing `legacy_base_url`/`new_base_url` for a selected mode fails fast at
config-load time with an actionable message, and a missing template variable
(e.g. `{{ env.TEST_USER_EMAIL }}`) fails loudly the moment a step tries to
substitute it, marking that scenario `pass: false`. Both are loud failures,
not silent ones — pharos#12's design point was never "a bad environment goes
unnoticed", it was that a misconfigured or narrowed **scenario directory**
could quietly shrink the run itself and still exit 0.

So, when checking whether a run actually exercised the suite you think it
did:

- **Read `summary.discovered`, not the pass fraction.** `73 passed, 0 failed`
  looks identical whether the run discovered 73 scenarios or 730 and only
  executed a tenth of them — `discovered` is the run's real denominator;
  `executed` is what got a chance to pass or fail.
- **Pin `min_scenarios` in CI.** The default of `1` only guards against
  discovering literally nothing. A repository with an 81-scenario corpus
  should set `min_scenarios: 81` (or whatever floor it actually expects), so
  an empty or misspelled `scenario_dir`, or a filter that quietly matches
  nothing, exits **20** naming the cause instead of a clean 0 with
  `0 discovered`.
- **A tag- or mode-narrowed CI gate keeps its configured floor** — see above.
  Narrowing the suite on purpose does not suspend the check that the narrowed
  suite itself came back with enough scenarios.

## In CI

Run Pharos like any other test gate. Separate live-comparison scenarios from
deterministic replay scenarios with tags, so CI can run the deterministic set
without a live legacy dependency. Recording updates are refused in CI by default.
