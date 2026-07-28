# Recording & replay

Recordings capture a known-good legacy interaction so it can be replayed against
the new service later — useful when legacy is unavailable in CI, or when
deterministic replay is wanted.

## Recording

A `legacy_record` scenario calls legacy and writes a fixture:

```yaml
mode: legacy_record
steps:
  - id: get-user
    request: { method: GET, path: /users/user-123 }
    recording:
      fixture: users/get-user-success/get-user.json
      safe_headers: [content-type]   # only these headers are recorded
```

Writes happen only via the `record` command (or `ALLOW_RECORDING_UPDATES=true`),
so a normal `run` never writes a fixture, and **CI refuses recording updates by
default**:

```bash
bun run ftest -- record --scenario users.record-existing-user
```

Recordings are redacted before they are written: only `safe_headers` are kept,
configured secret JSON paths are masked, and query params are masked. Because
plain-text and scalar bodies cannot be path-redacted, they are not persisted —
only JSON object/array bodies are recorded and replayable.

Captured `Set-Cookie` headers follow the same discipline: they are written to the
recording's optional `set_cookie` field **only** when `set-cookie` is listed in
`safe_headers`. A recording without that field replays with no cookie data (true
of every fixture written before cookie capture existed) — re-record to add it.

## Replay

A `replay_against_recording` scenario loads the recorded **response** as the
legacy side and sends the scenario's request to the new service:

```yaml
mode: replay_against_recording
contract: "../../contracts/user-service.contract.yaml#get-user"
steps:
  - id: get-user
    recording: { fixture: users/get-user-success/get-user.json }
    request: { method: GET, path: /users/user-123 }
    compare: { strategy: json_semantic, status: same }
```

Both the recorded response and the live new response are normalized by the same
contract, then compared. The scenario's request is sent (freshly
variable-substituted, so it carries current auth) — the recorded request is
redacted and so is not replayed; the recording is the response oracle. A missing
or invalid fixture fails clearly.

## Recording format

Fixtures are JSON (scenarios are YAML):

```json
{
  "version": 1,
  "scenarioId": "users.record-existing-user",
  "stepId": "get-user",
  "recordedAt": "2024-01-01T00:00:00.000Z",
  "request": { "method": "GET", "path": "/users/user-123" },
  "response": { "status": 200, "headers": {}, "bodyText": "...", "bodyJson": { }, "durationMs": 4 }
}
```

Fixture paths are confined to `fixture_dir`; an absolute path or a `..` escape is
rejected.
