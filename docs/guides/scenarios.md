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
  It is also the mode for writes on a shared store — see
  [multi-step flows and writes](#multi-step-flows-and-writes).
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
cases (empty lists, missing resources, invalid input, permission errors). For
writes it should follow [multi-step flows and writes](#multi-step-flows-and-writes):
cases derived from the legacy handler, pinned one-sidedly or to a paired
resource, never with a two-sided write or read-back. A human reviews the
result before it gates anything — the tools generate, people decide.

## Multi-step flows and writes

Steps run in order, and a scenario **stops at its first failed step**: the steps
after it never run and report nothing (`cleanup` still runs). A divergence early
in a flow therefore masks any divergence a later step would have shown, so give
each scenario one thing that can diverge and split a flow that checks several.
Scenarios themselves run one at a time in file-path order — see the
[execution pipeline](../reference/architecture.md#execution-pipeline) for what
that means on a shared datastore.

A scenario has one `mode`, and every step runs in it: a write step under
`compare_live` is sent to **both** services, which on a shared store performs
the write twice. Validate a write by performing it through the new service only,
then checking what it stored — but not with a read-back compared two-sided. On
a shared store legacy and new read the *same* row, so that comparison can pass
even when the write stored the wrong thing: it cannot establish that the write
was correct. Instead, pin the post-state one-sidedly to legacy-derived
expectations, or compare paired resources:

- **Pin one-sidedly.** A `new_only_assert` scenario makes the write, reads the
  resource back, and asserts both responses with `explicit_expectations`
  against what legacy would have returned and stored. Derive those values from
  the legacy handler's source, or by probing legacy on controlled data first. A
  `setup` hook can seed the row the write modifies through either base URL on
  the [hook context](variables-and-hooks.md#hooks) — the store is shared.
- **Compare paired resources.** When legacy's result is easier to observe than
  to derive, a `setup` hook makes the same write through legacy
  (`ctx.legacyBaseUrl`) on a resource of its own, reads it back, and `assign`s
  the fields that matter. The steps then make the write through new on a second
  resource and pin its read-back to those variables. Leave out ids and server
  timestamps, which differ by construction. Templated expectations compare
  field by field. A `custom` comparator gets no variable substitution or
  scenario context (its `args` arrive raw), so a whole-body paired diff needs a
  comparator that shares state with the setup hook in the same hooks module.

```yaml
version: 1
id: users.clear-nickname-destructive
name: Clearing a nickname stores null
service: user-service
mode: new_only_assert
tags: [write, regression, destructive]
safety:
  destructive: true
  allowedEnvironments: [local, ci, staging]
setup:
  hooks:
    - name: seedUser                 # creates the row; returns { id }
      # A non-null nickname, so the clear below is observable.
      args: { nickname: Ada, displayName: Ada Lovelace }
      assign: { userId: id }
steps:
  - id: clear-nickname
    request:
      method: PATCH
      path: /users/{{ variables.userId }}
      body: { nickname: null }
    compare:
      strategy: explicit_expectations
      expect: { status: 200 }
  - id: read-back
    request:
      method: GET
      path: /users/{{ variables.userId }}
    compare:
      strategy: explicit_expectations
      expect:
        status: 200
        body:
          json_paths:
            $.nickname: null                 # legacy clears on explicit null
            $.displayName: Ada Lovelace      # untouched by this PATCH
cleanup:
  hooks:
    - name: deleteUser
      args: { userId: "{{ variables.userId }}" }
```

The seed must hold a non-null `nickname`: seeded as `null`, a PATCH that
ignored its body would still read back `null` and pass. One-sided expectations
see the response *after* redaction, so never pin a path that `redact_paths` or
the config's `redaction.json_paths` covers — an email, say, would compare
against the mask. For a paired comparison, the expected values become templates
instead — `$.nickname: "{{ variables.legacyNickname }}"`; a whole-string
template keeps the value's type, `null` included.

**Write coverage.** Derive the cases from the legacy handler, not the new one.
For every field a write accepts, cover **set**, **change**, **clear** (an
explicit `null`, where the field is nullable) and **omit** (does legacy keep,
default, or clear it?), plus one scenario per validation rule, pinned to
legacy's status and error body. Seed the set, change and clear cases so the
expected post-state differs from the starting one — otherwise a write that does
nothing passes.

Mark write scenarios `destructive`, set the `safety` block, and add `cleanup`
hooks. The example `users.create-then-fetch-destructive` shows that wiring
(`safety`, a `setup` hook, `extract`, `cleanup`), but its POST runs under
`compare_live`, so it writes through both services. Against the example mocks
that is harmless — each keeps its own store, and the create is an upsert keyed
on the email — but against a shared store with server-generated ids the same
scenario performs the write twice, and no comparison is guaranteed to fail when
it does. Copy its wiring, not its write step.
