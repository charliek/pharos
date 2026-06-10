# Variables & hooks

## Variables

Templates `{{ namespace.key }}` are resolved in `path`, `query`, `headers`, and
`body`:

```
{{ variables.userId }}   {{ env.AUTH_TOKEN }}
{{ random.uuid }}        {{ random.int }}
{{ now.iso }}            {{ now.epochMs }}
```

A **whole-string** template yields the raw value, so an object stays an object:

```yaml
body: "{{ variables.userPayload }}"   # the object, not "[object Object]"
```

An **embedded** template is stringified into the surrounding text
(`/users/{{ variables.userId }}` → `/users/user-123`). A missing variable fails
with a clear message naming the variable and step.

## Extraction

A step can extract values from responses into the shared variable store, for
later steps:

```yaml
extract:
  userId: { from: new.body, path: $.id }
  etag:   { from: new.headers, path: etag }
```

Body extraction uses the JSONPath subset; header extraction uses a header name.
`response.*` is only valid in single-target modes (it's ambiguous when both
legacy and new responses exist).

## Hooks

A `hooks/index.ts` module (configurable via `hooks_module`) exports named hooks,
custom comparators, and custom normalizers. Scenarios reference them by name:

```ts
// hooks/index.ts
export const hooks = {
  generateUserPayload: () => ({ email: `grace-${crypto.randomUUID()}@example.com` }),
  deleteUser: async (ctx, args) => {
    /* best-effort cleanup using ctx.env base URLs */
  },
};
export const comparators = { compareDeviceList: (ctx) => [/* mismatches */] };
```

```yaml
setup:
  hooks:
    - name: generateUserPayload
      assign: { userEmail: email }   # merge hook output {email} into variables.userEmail

cleanup:
  hooks:
    - name: deleteUser
      args: { userId: "{{ variables.userId }}" }
```

A hook receives the scenario context (variables, env) and optional args, and may
return a map that an `assign` mapping merges into the variables. Hooks run as:
scenario **setup** → per-step **before**/**after** → scenario **cleanup**.

**Cleanup always runs** — even after a step or a setup/before hook fails — so
test data is not left behind. An unknown hook, or an `assign` that references a
key the hook did not return, fails clearly. Comparators and normalizers may live
in their own exports or among `hooks`; either authoring style works.
