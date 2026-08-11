# Architecture

Pharos is a library with a thin CLI. All logic lives in `src/` modules; the CLI
(`src/cli`) only parses arguments and dispatches, which keeps the harness
testable without spawning processes or binding sockets.

## Two artifacts

Pharos has two distinct inputs (spec §3.2):

- **Scenario specs** — the *executable* layer. Each scenario describes a request
  (or multi-step flow), its mode, variables, hooks, and how to compare. See the
  [scenario format](scenario-reference.md).
- **The behavioral contract** — the *shared comparison truth*. The same
  framework-agnostic file Limen consumes, holding the normalization vocabulary
  per service and route. See the [contract reference](contract-reference.md).

A scenario **references** a contract route (`path#routeId`) the same way a Limen
route does, so both tools read the identical file. Inline comparison rules are
supported for a quickstart fallback, using the same vocabulary — but a scenario
uses a contract **or** inline rules, never both.

## Execution pipeline

For each scenario (spec §3.3):

1. Initialize the scenario context (variables + environment).
2. Resolve scenario-level comparison rules (from the contract, if referenced).
3. Run scenario **setup** hooks.
4. For each step (stop on first failure):
   1. Run step **before** hooks.
   2. Resolve variables in the request.
   3. Execute the **legacy** and/or **new** request the mode requires
      (`compare_live` issues both concurrently).
   4. Store **extracted** variables for later steps.
   5. **Normalize** and **compare** per the strategy.
   6. Write redacted **artifacts** on failure.
   7. Run step **after** hooks.
5. Run scenario **cleanup** hooks — **always**, even after a failed step.
6. Emit the scenario result.

## Module map

The modules mirror spec §3.5:

| Module | Responsibility |
|---|---|
| `cli` | Argument parsing and command dispatch (`run`, `validate`, `record`, `check-contract`, `init`). |
| `config` | Layered config loading and mode-aware validation. |
| `contract` | Contract schema, loading, reference resolution, and rule merge. |
| `scenarios` | Scenario schema, loading, and discovery. |
| `execution` | The HTTP client, variable substitution/extraction, hooks, recording fixtures, and the step/scenario runners. |
| `comparison` | The JSONPath subset, normalization, the diff, the strategies, and redaction. |
| `reporting` | The console, JSON, and JUnit reporters and failure artifacts. |

## Comparison engine

Comparison is a pure function of the merged rules and the two responses — it has
no dependency on scenarios, config, or the network, which keeps it easy to test.
It normalizes both bodies, then applies the scenario's strategy. See
[comparison & contracts](../guides/comparison-and-contracts.md).

## Safety posture

Pharos defaults toward safe, trustworthy results: destructive scenarios and
recording updates require explicit opt-in, secrets are redacted on every output
surface, and normalization is deterministic. See [reporting & CI](../guides/reporting-and-ci.md)
and the spec's Section 12.
