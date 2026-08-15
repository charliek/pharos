# Contract

The behavioral contract is the portable artifact shared with Limen. It owns the
comparison truth — *what to compare and how* — and never operational concerns.
Field names are snake_case so a single file is portable, unchanged, between
Pharos and Limen (spec Section 5).

## Format

```yaml
version: 1
service: user-service
description: >
  Drafted from OpenAPI + traffic, refined by Pharos, consumed by Limen.

# Service-wide defaults. Per-route `comparison` blocks merge on top of these:
# scalar fields override, list fields concatenate.
defaults:
  compare_status: true
  compare_body: true
  compare_headers: []            # headers compared only if listed
  json:
    ignore_paths:
      - "$.metadata.requestId"
    redact_paths:
      - "$.email"
    sort_arrays:
      - path: "$.items"
        key: "id"
    unordered_arrays:
      - path: "$.permissions"
    normalize_timestamps:
      - path: "$.createdAt"
        precision: seconds
    enum_aliases:
      - path: "$.status"
        aliases: { ACTIVE: enabled, INACTIVE: disabled }
  # Two optional comparison dimensions; omitted at every layer = not compared.
  set_cookie:
    compare: true                # master switch
    ignore_cookies: []           # cookie names excluded entirely
    ignore_attributes: []        # e.g. [Expires] — clock-dependent attributes
    compare_values: exact        # exact | presence (presence: name + attributes)
  location:
    compare: true
    ignore_query_params: []      # e.g. [state, nonce]
    origin: exact                # exact | ignore (ignore: path + query only)

routes:
  - id: "get-user"
    match:
      methods: ["GET"]
      path_template: "/users/{id}"
    comparison:
      json:
        ignore_paths: ["$.lastSeenAt"]   # merged with defaults
    expectations:
      typical_status: 200
      notes: "Legacy 200 on soft-deleted; new 404 — intentional change."
    tags: [read, migration-ready]
```

## Normalization vocabulary

| Rule | Effect |
|---|---|
| `ignore_paths` | Remove the matched fields before comparing. |
| `redact_paths` | Mask the matched values (compared by presence, never by value; never leaked). |
| `sort_arrays` | Order an array by a stable element key (tie-broken on the full element). |
| `unordered_arrays` | Order an array as a set. |
| `normalize_timestamps` | Parse, convert to UTC, and truncate to the precision (`milliseconds` — spelled `millis` in Limen's own output, both accepted — `seconds`, `minutes`, `hours`, `days`). |
| `enum_aliases` | Map equivalent enum spellings to one canonical token. |

`compare_status`, `compare_body` (booleans) and `compare_headers` (a list) round
out the block. Object key order is always canonicalized, so it never causes a
false mismatch.

## Set-Cookie and Location

`set_cookie` and `location` are comparison **dimensions of their own**, not
`compare_headers` entries: `Set-Cookie` is multi-valued (a single-value header
map keeps only the last one) and `Location` needs URL semantics. Declaring
either block anywhere — service `defaults` or a route's `comparison` — turns
that dimension on; omitting it everywhere means it is not compared at all. A
block that is present but empty (`location: {}`) takes every default shown
above. Naming these dimensions in `compare_headers` (any case) is a
**load-time validation error** — drop the entry — though the two differ in
when it fires. `set-cookie` is rejected unconditionally:
`compare_headers` reads the single-value header map, so a multi-cookie response
would be compared on one value with the rest dropped; use a `set_cookie` block.
`location` is rejected only while a `location` block is present.

Cookies pair by name (duplicates pair positionally within the name group);
attribute names are case-insensitive, attribute values exact, cookie names
case-sensitive. A relative `Location` is resolved against the URL of the request
that produced the response before its origin, path, and query are compared —
the query as a name → values map, so parameter order never matters. Cookie
values are never rendered into any output, and `Location` query values are
masked for secret-bearing parameter names (`code`, `access_token`, …). Full
semantics: spec Section 8.6, held in lockstep with Limen by a shared fixture.

## Supported JSONPath subset

To stay portable with Limen, exactly three forms are supported:

- `$.field`
- `$.nested.field` (arbitrary depth)
- `$.items[*].field` (one `[*]` wildcard, between two fields)

Anything else — array indices (`[0]`), recursive descent (`..`), bracket or
filter notation, a bare `$`, a wildcard at the root or trailing, or more than one
wildcard — is a validation error at load time. The subset may expand later, in
lockstep with Limen.

## Merge

When a scenario references a route, Pharos merges service `defaults` with the
per-route `comparison` (scalars override, list fields concatenate) into the rules
the engine uses. A scenario references a contract **or** declares inline rules in
the same vocabulary, never both. Contracts are loaded once at run start and are
not hot-reloaded — a run uses fixed comparison semantics.
