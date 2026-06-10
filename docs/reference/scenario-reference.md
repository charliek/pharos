# Scenario format

Scenarios are YAML (JSON is accepted for generated specs). This is the full
field reference; see [writing scenarios](../guides/scenarios.md) for guidance and
the spec's Section 4 for the authoritative definition.

## Top-level fields

| Field | Required | Description |
|---|---|---|
| `version` | ✓ | Integer; `1` for the MVP. |
| `id` | ✓ | Stable unique id, lowercase, dot/slash/dash-separated (`users.get-user-success`). |
| `name` | ✓ | Human-readable name. |
| `description` | | Why the behavior matters. |
| `service` | ✓ | Service identifier; must match the contract's `service` when referenced. |
| `tags` | ✓ | Non-empty list, used for filtering and reporting. |
| `mode` | ✓ | One of the [execution modes](#execution-modes). |
| `safety` | | Safety metadata (see below). |
| `contract` | | Reference to shared rules (`path#routeId`). Mutually exclusive with inline behavioral rules. |
| `variables` | | Map of scenario variables. |
| `setup` / `cleanup` | | Scenario-level hook blocks. |
| `steps` | ✓ | One or more steps. |

## Execution modes

| Mode | Calls | Notes |
|---|---|---|
| `compare_live` | legacy + new | Concurrent reads; compare per strategy. |
| `legacy_record` | legacy | Writes a fixture only when recording is enabled. |
| `replay_against_recording` | new + a recorded legacy response | Deterministic replay. |
| `new_only_assert` | new | Strategy must be `explicit_expectations` or `custom`. |

## Steps

```yaml
steps:
  - id: get-user
    name: Fetch user by id          # optional
    request:
      method: GET                    # GET | POST | PUT | PATCH | DELETE
      path: /users/{{ variables.userId }}
      query: { includeDetails: true }
      headers: { authorization: "Bearer {{ env.AUTH_TOKEN }}" }
      body: { ... }                  # object → JSON; string → sent verbatim
      timeoutMs: 5000                # optional per-request override
    extract:
      userId: { from: new.body, path: $.id }
    recording:                       # legacy_record / replay
      fixture: users/get-user.json
      safe_headers: [content-type]   # only these headers are recorded
    before: { hooks: [...] }         # step-level hooks
    after: { hooks: [...] }
    compare: { ... }                 # see comparison strategies
```

Extraction `from` is one of `legacy.body`, `new.body`, `response.body`,
`legacy.headers`, `new.headers`, `response.headers`. Body extraction uses the
JSONPath subset; header extraction uses a header name. `response.*` is only valid
in single-target modes.

## Comparison strategies

```yaml
compare:
  strategy: json_semantic           # exact | json_semantic | subset | explicit_expectations | custom
  status: same                      # require equal status
  headers: { compare: [content-type], ignore: [date] }   # inline only
  body:
    require_matching_paths: [$.id, $.name]                # subset
    ignore_paths: [$.metadata.requestId]                  # inline normalization
    sort_arrays: [{ path: $.items, key: id }]
  expect:                            # explicit_expectations
    status: 404
    body:
      json_paths:
        $.error.code: USER_NOT_FOUND
  comparator: compareDeviceList      # custom (named hook)
  args: { ignore_offline_timestamp: true }
```

`explicit_expectations` must assert at least `expect.status` or a non-empty
`expect.body.json_paths`. The behavioral normalization vocabulary under
`compare.body` (ignore_paths, redact_paths, sort_arrays, unordered_arrays,
normalize_timestamps, enum_aliases) is the **inline fallback** — using it together
with a `contract` reference is a validation error.

## Safety metadata

```yaml
safety:
  destructive: false                       # required true when tagged destructive
  requiresProductionGuardOverride: false   # needs ALLOW_PRODUCTION_GUARD_OVERRIDE
  allowedEnvironments: [local, ci, staging]
```

Destructive scenarios are skipped unless `ALLOW_DESTRUCTIVE_TESTS=true`; the
production guard and environment list add further gates (spec Section 12).
