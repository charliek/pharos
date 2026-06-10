# Writing scenarios

A scenario captures one behavior or journey as a small, reviewable YAML file. A
good scenario is stable across environments, explicit about what matters, clear
about which dynamic fields are ignored, focused on one thing, and small enough to
review in a pull request.

## The shape

```yaml
version: 1
id: users.get-user-success
name: Get an existing user
service: user-service
tags: [read, smoke, migration-ready]
mode: compare_live
contract: "../../contracts/user-service.contract.yaml#get-user"
variables:
  userId: user-123
steps:
  - id: get-user
    request:
      method: GET
      path: /users/{{ variables.userId }}
    compare:
      strategy: json_semantic
      status: same
```

The `mode` decides which services are called; the `compare.strategy` decides
*how* to compare; the `contract` decides *what to normalize/ignore/redact* first.
The full field list is in the [scenario reference](../reference/scenario-reference.md).

## Choosing a mode

- **`compare_live`** for reads, when both services are available — the
  straightforward path. Pharos issues the request to both concurrently and diffs.
- **`new_only_assert`** for net-new behavior, intentional changes, or
  healthchecks — assert explicit expectations against the new service alone.
- **`replay_against_recording`** when legacy is unavailable or deterministic
  replay is wanted — see [recording & replay](recording-and-replay.md).
- **`legacy_record`** to capture a known-good legacy interaction.

## Choosing a strategy

| Strategy | Use for |
|---|---|
| `json_semantic` | The default for JSON APIs — structural comparison after normalization. |
| `exact` | Status, selected headers, and the normalized body must match. |
| `subset` | Only specific paths must match (`require_matching_paths`). |
| `explicit_expectations` | Assert literal values (`new_only_assert`). |
| `custom` | A service-specific comparator from the hook registry. |

## Generating scenarios with an agent

When an AI agent drafts scenarios it should: keep each scenario small and
focused; include a clear description; tag consistently; mark destructive tests
explicitly; never hardcode secrets; add ignore rules only with a reason; prefer
semantic JSON comparison; cover both success and error cases; and include edge
cases (empty lists, missing resources, invalid input, permission errors). A human
reviews the result before it gates anything — the tools generate, people decide.

## Multi-step flows and writes

Writes are validated by performing the write through the new service and reading
the result back through an already-validated read path (a multi-step scenario),
rather than executing the write against both implementations. Mark such scenarios
`destructive`, set the `safety` block, and add `cleanup` hooks. See the example
`users.create-then-fetch-destructive`.
