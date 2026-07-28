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
      method: GET                    # GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD
      path: /users/{{ variables.userId }}   # absolute URL allowed iff same-origin
      query: { includeDetails: true }
      headers: { authorization: "Bearer {{ env.AUTH_TOKEN }}" }
      body: { ... }                  # object → JSON; string → sent verbatim
      form: { grant_type: ... }      # urlencoded; mutually exclusive with body
      follow_redirects: true         # default true; false returns the 30x itself
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

OPTIONS and HEAD must not set `body` or `form` (a validation error): bodies on
those methods are unreliable across HTTP implementations. With
`follow_redirects: true` (the default) intermediate 30x hops are invisible — walk
a redirect chain one step per hop with `follow_redirects: false`, replaying the
extracted `Location` as the next step's `path`.

Extraction `from` is one of `legacy.body`, `new.body`, `response.body`,
`legacy.headers`, `new.headers`, `response.headers`, `legacy.set_cookie`,
`new.set_cookie`, `response.set_cookie`. Body extraction uses the JSONPath
subset; header extraction uses a header name; `*.set_cookie` extraction uses a
cookie **name** and yields that cookie's value from the lossless multi-value
capture (last occurrence wins; attributes are never extracted). `response.*` is
only valid in single-target modes.

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
  set_cookie: { ignore_attributes: [Expires] }            # inline dimension
  location: { ignore_query_params: [state], origin: exact }
  expect:                            # explicit_expectations
    status: 404
    headers: { x-frame-options: DENY }        # exact, case-insensitive names
    header_absent: [x-forwarded-host]
    header_present: [retry-after]              # any non-empty value, not asserted exactly
    body:
      json_paths:
        $.error.code: USER_NOT_FOUND
        $.identity_id: "{{ variables.identityId }}"  # templated (see below)
    set_cookie:                                # order-insensitive
      - name: session
        value_present: true                    # or `value: <exact>`, never both
        attributes: { Path: /, HttpOnly: true } # true/false = flag presence
        exact_attributes: false                 # true: the full attribute set
    set_cookie_absent: [refresh]               # no Set-Cookie entry with this name
    location:
      path: /login
      query: { error: access_denied }
      query_present: [return_to]
      query_absent: [client_secret]
  comparator: compareDeviceList      # custom (named hook)
  args: { ignore_offline_timestamp: true }
```

`explicit_expectations` must assert at least one of `expect.status`,
`expect.body.json_paths`, `expect.headers`, `expect.header_absent`,
`expect.header_present`, `expect.set_cookie`, `expect.set_cookie_absent`,
`expect.location`. Naming `set-cookie` or `cookie` in `expect.headers` /
`expect.header_absent` / `expect.header_present` is a validation error — those
read the lossy single-value header map; assert cookies with `expect.set_cookie`
/ `expect.set_cookie_absent`, which read the lossless capture. Each `set_cookie`
entry consumes the first not-yet-consumed response cookie of that name, in
response order; response cookies no expectation consumed are not an error.
`set_cookie_absent` checks the whole response by name instead — presence only,
independent of any `set_cookie` block's consumption on the same step. A
relative `Location` is resolved against the request URL before its parts are
asserted. Cookie values are never rendered into a failure, expected or actual.

Every string value inside `expect` — `headers`, `header_absent`,
`header_present`, `body.json_paths`, `set_cookie` (`name`/`value`/`attributes`),
`set_cookie_absent`, and `location` — is substituted with the same
`{{ variables.x }}` / `{{ env.X }}` engine requests use, evaluated after this
step's own extraction. `expect.status` is the one exception and is never
templated. A whole-string template preserves the resolved value's type, so a
templated `body.json_paths` value or cookie `attributes` entry need not be a
string.

The behavioral vocabulary under `compare.body` (ignore_paths, redact_paths,
sort_arrays, unordered_arrays, normalize_timestamps, enum_aliases) plus
`compare.set_cookie` / `compare.location` is the **inline fallback** — using any
of it together with a `contract` reference is a validation error.

## Safety metadata

```yaml
safety:
  destructive: false                       # required true when tagged destructive
  requiresProductionGuardOverride: false   # needs ALLOW_PRODUCTION_GUARD_OVERRIDE
  allowedEnvironments: [local, ci, staging]
```

Destructive scenarios are skipped unless `ALLOW_DESTRUCTIVE_TESTS=true`; the
production guard and environment list add further gates (spec Section 12).
