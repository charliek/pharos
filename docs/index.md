# Pharos

**A black-box functional test suite that validates a new service against a
legacy one — deterministically, from the outside — before and during a
migration.**

*Pharos* was the great lighthouse of Alexandria: the fixed reference that let
ships verify their position and cross safely. Pharos the test suite is the
fixed, deterministic reference against which a new service's behavior is checked
before it carries real traffic.

## The problem it solves

Rewriting a service onto a supported framework is usually a *behavioral bet*:
the team reimplements the service, ships it, and hopes it behaves like the
original. Subtle differences — a changed error shape, a dropped field, a
timestamp format, an off-by-one in pagination — surface in production as
incidents, after the old implementation is gone.

Pharos removes the bet on the testing side. It treats both systems as black-box
HTTP APIs, issues the same request to each, and compares the responses — turning
"does the rewrite behave like the original?" into a test that either passes or
fails, locally and in CI, *before* users depend on the new service.

Because it speaks only HTTP, nothing in Pharos is specific to the language or
framework either side is written in. The first wave it targets is Kotlin/Java
services on Ratpack being rewritten in Rust or Kotlin Spring Boot, but a service
written in anything that serves HTTP is a valid target.

```
            ┌──────────────── pharos ────────────────┐
  scenario  │                                         │───▶  legacy  (reference)
  (YAML) ──▶│  resolve vars → request → normalize      │
            │     │                                     │───▶  new     (the rewrite)
            │     └─ compare per contract ── diff ──────│
            └─────────────────────────────────────────-┘
                 pass / fail · readable diffs · CI artifacts
```

## What it does

- **Compare live** — call both `legacy` and `new` and diff the responses
  semantically, ignoring incidental differences declared in the contract.
- **Record & replay** — capture known-good legacy interactions and replay them
  against the new service when legacy is unavailable or deterministic replay is
  wanted.
- **Assert new-only** — drive the new service alone and check explicit
  expectations, for intentionally changed or net-new behavior.
- **Refine the contract** — catch over-normalization (hiding a real difference)
  and under-normalization (false failures on dynamic fields), tightening the
  rules that drive production rollout.

## How it fits the bigger picture

Pharos is the **pre-production** half of a two-tool migration approach:

- **Pharos** (this project, TypeScript/Vitest) validates the new service against
  legacy in development and CI, and *refines* the behavioral contract.
- **[Limen](limen_spec.md)** (a separate Rust project) is the runtime migration
  proxy. It *consumes* that refined contract unchanged, applying the same
  normalization and comparison vocabulary to live shadow traffic, then rolls
  traffic over gradually and reversibly.

The two share a [behavioral contract](pharos_spec.md) — a portable YAML/JSON
description of what to compare and which incidental differences don't count —
but have **no build-time dependency** on each other.

```
   AI investigation            Pharos                      Limen
 (docs, OpenAPI, traffic)  (validate + refine)      (consume + roll out)
        │                        │                          │
        ▼                        ▼                          ▼
   DRAFTS the contract ──▶ VALIDATES & REFINES it ──▶ CONSUMES it unchanged
```

The [migration runbook](runbook.md) is the operational procedure that ties the
two tools together; the [PR/FAQ](prfaq.md) explains the motivation.

## Design priorities

Pharos's defaults all lean toward trustworthy, reviewable results:

1. **Correctness and clear error messages** first — failures name the file and
   field.
2. **One normalization vocabulary and one JSONPath subset**, shared with Limen,
   so a contract is portable between the two tools unchanged.
3. **No secret value in any output** — redaction applies to logs, reports,
   artifacts, and recordings.
4. **Deterministic output** — normalization is order- and
   environment-independent.
5. **Safe by default** — destructive scenarios and recording updates require
   explicit opt-in.

## Get started

- [Installation](getting-started/installation.md) — provision the toolchain.
- [Quickstart](getting-started/quickstart.md) — the shape of a scenario and a
  comparison run.

For the full design, read the [Pharos specification](pharos_spec.md).
