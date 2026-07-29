# Comparison & contracts

When Pharos compares two responses, the scenario's **strategy** decides *how* to
compare and the **contract** decides *what to normalize, ignore, and redact*
first. This page covers the engine; the rules live in the
[contract](../reference/contract-reference.md).

## Normalization

Normalization makes incidental differences disappear so only meaningful ones
remain. It runs on a deep clone of each parsed body, in spec order (§8.2):

| Rule | Effect |
|---|---|
| `ignore_paths` | Remove the matched fields entirely. |
| `redact_paths` | Mask the matched values (so secrets never reach a diff). |
| `sort_arrays` | Order an array by a stable element key, tie-broken on the full element. |
| `unordered_arrays` | Order an array as a set. |
| `normalize_timestamps` | Parse, convert to UTC, and truncate to the configured precision. |
| `enum_aliases` | Map equivalent enum spellings to one canonical token. |

Object key order is canonicalized, so **key order never causes a false
mismatch**. Normalization is deterministic and order-independent.

## `set_cookie` and `location`

Two further, **optional** comparison dimensions sit alongside the JSON body
rules above — declared under `defaults`/`comparison` in the contract (or
inline under `compare.set_cookie` / `compare.location`), not as
`compare_headers` entries, since `Set-Cookie` is multi-valued and `Location`
needs URL semantics. `set_cookie` pairs `Set-Cookie` entries by name
(`compare_values: exact | presence`, with `ignore_cookies` /
`ignore_attributes` escape hatches); `location` parses the `Location` header
as a URL, resolving a relative value against the request first, and compares
origin/path/query (`ignore_query_params`, `origin: exact | ignore`). Omitted
at every layer, a dimension is not compared at all. Cookie values are never
rendered into a mismatch — see [contract reference](../reference/contract-reference.md#set-cookie-and-location)
for the full field list.

!!! note "Timestamps are converted, not relabeled"
    `normalize_timestamps` parses the value, converts it to UTC, and truncates to
    the precision. `2024-01-01T12:30:45+05:30` and `...T07:00:45Z` normalize equal
    (same instant); two genuinely different instants stay different — so the rule
    can never mask a real time bug.

## Strategies

- **`json_semantic` / `exact`** — compare status (when required), listed headers,
  and the normalized body, emitting path-addressed mismatches.
- **`subset`** — compare only `require_matching_paths` between the two responses.
- **`explicit_expectations`** — compare the new response against literal values;
  redacted paths are still masked so a secret can't leak through an assertion.
- **`custom`** — delegate to a named comparator; it receives **redacted** response
  views so it cannot surface a secret into a report — `Set-Cookie` values are
  masked in that view unconditionally, regardless of the scenario's
  `sensitiveHeaders` config.

## Redaction — no secret in any output

Redaction is a load-bearing guarantee (spec §8.5): no secret value appears in the
console, the JSON/JUnit reports, the failure artifacts, or a recording. Body
secrets are masked during normalization (so they never reach the diff); header
names and query params are masked on every output surface; and the operator's
`redaction.json_paths` augment the contract's `redact_paths` at run time. A test
proves no configured secret reaches any artifact.

## Refining the contract

Pharos is where an AI-drafted contract earns trust. When a scenario fails,
diagnose which kind it is and act:

- **A real gap in the new service** → fix the new service (the productive
  majority).
- **A legitimate dynamic difference** → add a *narrow* contract rule, with a
  reason.
- **An over-broad rule hiding something** → tighten it; the failure it surfaces is
  real.
- **An intended difference** → assert the new behavior and tag `intentional-change`.

Resist silencing a failure by widening an ignore path — that is the failure mode
the whole approach is designed to prevent. A contract that has survived Pharos
refinement is what Limen then consumes, unchanged, against production traffic.
