# Quickstart

This page walks through the shape of a Pharos run: a scenario file, the shared
contract it references, and the CLI commands that validate and execute it.

## 1. Describe a scenario

A scenario is a small, reviewable YAML file describing a request (or a
multi-step flow), how to compare the responses, and which contract rules apply:

```yaml
# scenarios/users/get-user-success.yaml
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
      headers:
        authorization: Bearer {{ env.AUTH_TOKEN }}
    compare:
      strategy: json_semantic
      status: same
```

The `mode` decides which services are called (`compare_live` calls both); the
`compare.strategy` decides *how* to compare; the referenced `contract` decides
*what to normalize, ignore, and redact* before comparing.

## 2. Describe the contract

The behavioral contract is the portable artifact shared with Limen. It owns the
comparison truth — every normalization rule is a deliberate exception to the
default posture of *compare everything*:

```yaml
# contracts/user-service.contract.yaml
version: 1
service: user-service
defaults:
  compare_status: true
  compare_body: true
  json:
    ignore_paths:
      - "$.metadata.requestId"     # per-request, non-deterministic
    redact_paths:
      - "$.user.email"             # never appears in a log or diff
routes:
  - id: "get-user"
    match:
      methods: ["GET"]
      path_template: "/users/{id}"
    tags: [read, migration-ready]
```

## 3. Validate before you run

Pharos validates scenarios and contracts *semantically* — required fields,
known enum values, resolvable contract references, and JSONPath-subset
compliance — and reports failures with the file and field path:

```bash
bun run ftest -- validate
bun run ftest -- check-contract contracts/user-service.contract.yaml
```

`check-contract` produces the same verdict Limen would, since both tools
implement the identical [JSONPath subset](../pharos_spec.md).

## 4. Run a comparison

```bash
bun run ftest -- run --scenario users.get-user-success
# or by tag:
bun run ftest -- run --include-tag smoke --exclude-tag destructive
```

Pharos resolves variables, issues the request to each service the mode requires,
normalizes both responses with the merged contract rules, compares them, and
prints a readable pass/fail with status, header, and body diffs. On failure it
writes redacted artifacts under `reports/` for inspection. The run exits
non-zero if any required scenario fails — so it can gate a CI build.

## The execution modes

| Mode | Calls | Use for |
|---|---|---|
| `compare_live` | legacy + new | Active compatibility validation when both are available. |
| `replay_against_recording` | new + a recorded legacy response | Deterministic replay when legacy is unavailable. |
| `legacy_record` | legacy only | Capturing known-good legacy behavior into a fixture. |
| `new_only_assert` | new only | Intentionally changed, new, or legacy-absent behavior. |

## Next steps

- [Pharos specification](../pharos_spec.md) — the full scenario and contract
  format, the comparison engine, and the phased build.
- [Migration runbook](../runbook.md) — how scenarios and the contract fit into
  an end-to-end migration.
