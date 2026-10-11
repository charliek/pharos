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
  what it read. The steps then make the write through new on a second
  resource and compare its read-back with those variables. Leave out ids and
  server timestamps, which differ by construction. Templated expectations
  compare path by path; a whole-string template can also pin a whole
  sub-object, by deep equality and with no normalization. For a whole-body
  comparison, `assign` the entire legacy read-back to one variable and hand it
  to a `custom` comparator through `compare.args`, which is templated like
  `expect` — see [comparing a whole body](#comparing-a-whole-body) below.

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

**Rehearse against legacy.** Before trusting hand-pinned expectations, run the
suite once with new's base URL pointed at legacy (the environment variable
overrides the config file, and nothing rejects equal base URLs), reporting
somewhere other than the real run's `report_dir`:

```bash
NEW_BASE_URL=http://legacy.internal ALLOW_DESTRUCTIVE_TESTS=true \
  REPORT_DIR=reports/rehearsal bun run ftest -- run --exclude-tag intentional-change
```

Write legacy's URL out, non-empty: an empty `NEW_BASE_URL` (an unset
`$LEGACY_BASE_URL`, say) is ignored, so new's configured URL stays in force and
the "rehearsal" quietly calls new. The destructive opt-in is what runs the
write pins at all; without it they are skipped, and skips can still exit 0, so
check the summary's `skipped` count. And leave out the `new_only_assert`
scenarios that pin intentional changes or net-new behaviour (here by the
`intentional-change` tag): they are expected to fail against legacy.

Every other one-sided pin (`new_only_assert`, or an `expect` inside
`compare_live`) then runs against legacy and must pass, which shows the pins
encode what legacy actually does — so a later failure against new is new's
divergence, not a wrong pin. Every two-sided read becomes legacy
against itself and should pass too; one that fails has found non-determinism
the contract does not ignore yet (a request id, a server timestamp), not a
migration difference. A paired scenario pairs two legacy writes, and a replay
compares legacy with its own recording. A green rehearsal proves the pins are
true of legacy, not that they are strong enough to catch a divergence; the
seeding rule above covers that. The write scenarios really write to legacy's
store (on a shared store, the same store new writes to), so rehearse only
against a legacy you may write to. A
`new_only_assert` write reaches legacy once; a write step under `compare_live`
is sent to legacy twice, concurrently, so expect duplicate rows, or a spurious
mismatch where legacy rejects the second copy. Hooks see legacy's URL as
`ctx.newBaseUrl` too.

Mark write scenarios `destructive`, set the `safety` block, and add `cleanup`
hooks. The example `users.create-then-fetch-destructive` shows that wiring
(`safety`, a `setup` hook, `extract`, `cleanup`), but its POST runs under
`compare_live`, so it writes through both services. Against the example mocks
that is harmless — each keeps its own store, and the create is an upsert keyed
on the email — but against a shared store with server-generated ids the same
scenario performs the write twice, and no comparison is guaranteed to fail when
it does. Copy its wiring, not its write step.

### Comparing a whole body

To compare new's whole read-back with legacy's, the `setup` hook returns the
legacy read-back body and `assign`s it to one variable, and the read-back step
hands that variable to a `custom` comparator from your hooks module:

```yaml
mode: new_only_assert                # plus safety and cleanup, as above
setup:
  hooks:
    - name: createUserViaLegacy      # POSTs through ctx.legacyBaseUrl, GETs it back,
      args: { nickname: Ada }        # and returns { user: <the read-back body> }
      assign: { legacyUser: user }
steps:
  # ...the same write through new, extracting newUserId...
  - id: read-back
    request: { method: GET, path: "/users/{{ variables.newUserId }}" }
    compare:
      strategy: custom
      comparator: matchesExpected
      args:
        expected: "{{ variables.legacyUser }}"   # whole-string: stays an object
        skip: [$.id, $.createdAt]                # differ by construction
```

Under `new_only_assert` the comparator is called with `{ legacy, candidate,
rules, args }`: `legacy` is undefined, `candidate` is new's read-back, `rules`
is the step's comparison rules, and `args` is the substituted block — so
`args.expected` is the legacy body itself. It returns a list of mismatches
(`path`, `kind`, `expected`, `actual`, `message`), which the report renders as
`expected:` / `actual:`. Pharos normalizes nothing before the call, so the
comparator applies its own skips (`args.skip` here; `rules.json.ignore_paths`
is there too). Redaction is lopsided: `candidate` arrives masked at every path
in `rules.json.redact_paths` (the contract's plus the config's
`redaction.json_paths`), but `args` is not masked, so the legacy body still
holds those values. Skip every redacted path on both sides, and never copy a
redacted path's value into a mismatch: Pharos masks a comparator's mismatches
only for registered sensitive values and sensitive header names, never by JSON
path. See
[`compare.args`](../reference/scenario-reference.md#comparison-strategies) for
the substitution rules.
