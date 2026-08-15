import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REDACTED } from '../src/comparison/redaction';
import {
  CIRCULAR_NOTE,
  MIN_SUBSTRING_LENGTH,
  maskMismatches,
  SensitiveValues,
  sensitiveMarker,
} from '../src/comparison/sensitive';
import { defaultConfig, type PharosConfig } from '../src/config/config';
import { ContractRegistry } from '../src/contract/load';
import { runScenario } from '../src/execution/runner';
import { loadScenarioFromText } from '../src/scenarios/load';
import { replyJson, startTestServer, type TestServer } from './helpers/server';

/**
 * Sensitivity propagation (spec Section 8.5): a value extracted from a
 * secret-bearing source stays masked in every output surface, no matter which
 * field a later step substitutes it into.
 *
 * Every test here is a falsification test — it asserts both that the secret is
 * absent from the surface *and* that the `[REDACTED:<name>]` marker is present,
 * so a test cannot pass because the surface was empty or the run never happened.
 */

describe('SensitiveValues — masking policy', () => {
  it('documents the length floor: a short value is masked whole, but not inside a composite', () => {
    // A known, deliberate bound rather than an oversight: replacing a very
    // short string everywhere it occurs would corrupt unrelated output, so the
    // guarantee below the floor is whole-value only — and registration warns.
    const seven = 'SEVENCH';
    const eight = 'EIGHTCHR';
    expect(seven).toHaveLength(MIN_SUBSTRING_LENGTH - 1);
    expect(eight).toHaveLength(MIN_SUBSTRING_LENGTH);
    const values = new SensitiveValues(() => {});
    values.register('short', seven);
    values.register('long', eight);

    // Exact equality masks regardless of length — no short-value exemption.
    expect(values.maskString(seven)).toBe('[REDACTED:short]');
    expect(values.maskString(eight)).toBe('[REDACTED:long]');
    // The residual: below the floor a composite string keeps the value.
    expect(values.maskString(`Bearer ${seven}`)).toBe(`Bearer ${seven}`);
    expect(values.maskString(`Bearer ${eight}`)).toBe('Bearer [REDACTED:long]');
  });

  it('warns about a short value, naming the variable and never the value', () => {
    const warnings: string[] = [];
    const values = new SensitiveValues((message) => warnings.push(message));
    values.register('pin', 'abc123');
    values.register('pin', 'abc123'); // re-extracted: warned once, not twice
    values.register('token', 'LONG-ENOUGH-TOKEN');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'pin'");
    expect(warnings[0]).not.toContain('abc123');
    expect(warnings[0]).toMatch(/shorter than 8 characters/);
  });

  it('embeds a Bearer-prefixed secret inside a composite header value', () => {
    const values = new SensitiveValues();
    values.register('sid', 'SUPER-SECRET-SESSION');
    expect(values.maskString('Bearer SUPER-SECRET-SESSION')).toBe('Bearer [REDACTED:sid]');
  });

  it('treats a value with regex metacharacters literally (no pattern injection)', () => {
    const values = new SensitiveValues();
    values.register('rx', 'a.*b+c?[d](e)|f$');
    // The literal value is masked wherever it appears…
    expect(values.maskString('x a.*b+c?[d](e)|f$ y')).toBe('x [REDACTED:rx] y');
    // …and a string the value would *match* as a regex is left completely alone.
    expect(values.maskString('aXXXbbbc[d](e)|f$')).toBe('aXXXbbbc[d](e)|f$');
  });

  it('replaces every occurrence and prefers the longest candidate', () => {
    const values = new SensitiveValues();
    values.register('outer', 'OUTER-SECRET-VALUE');
    values.register('inner', 'SECRET-VALUE');
    // Longest-first, so the contained value cannot mask half of the longer one.
    expect(values.maskString('a OUTER-SECRET-VALUE b')).toBe('a [REDACTED:outer] b');
    expect(values.maskString('OUTER-SECRET-VALUE and SECRET-VALUE again SECRET-VALUE')).toBe(
      '[REDACTED:outer] and [REDACTED:inner] again [REDACTED:inner]',
    );
  });

  it('names the first-registered variable when two variables share a value', () => {
    const values = new SensitiveValues();
    values.register('sidA', 'SHARED-SECRET-VALUE');
    values.register('sidB', 'SHARED-SECRET-VALUE');
    expect(values.maskString('SHARED-SECRET-VALUE')).toBe('[REDACTED:sidA]');
    expect(values.maskString('x SHARED-SECRET-VALUE y')).toBe('x [REDACTED:sidA] y');
    expect(values.names).toEqual(['sidA']);
  });

  it('masks the percent- and form-encoded forms of a value', () => {
    const values = new SensitiveValues();
    const secret = 'se cr/et+val=ue';
    values.register('tok', secret);
    const percent = encodeURIComponent(secret); // space -> %20
    const form = new URLSearchParams({ v: secret }).toString().slice(2); // space -> +
    expect(percent).not.toBe(form);
    expect(values.maskString(`https://h/p?token=${percent}`)).toBe(
      'https://h/p?token=[REDACTED:tok]',
    );
    expect(values.maskString(`token=${form}`)).toBe('token=[REDACTED:tok]');
  });

  it('never registers an empty string, a boolean, or null', () => {
    const values = new SensitiveValues();
    values.register('empty', '');
    values.register('flag', true);
    values.register('nothing', null);
    values.register('emptyBundle', { a: null, b: true, c: '' });
    expect(values.isEmpty).toBe(true);
    expect(values.maskString('true')).toBe('true');
  });

  it('registers every scalar leaf of an extracted object, however deeply nested', () => {
    const values = new SensitiveValues();
    values.register('bundle', {
      access_token: 'ACCESS-TOKEN-VALUE',
      nested: { refresh_token: 'REFRESH-TOKEN-VALUE', list: ['LIST-TOKEN-VALUE'] },
    });
    // A container registered as a whole must not leave its leaves live.
    expect(values.isEmpty).toBe(false);
    expect(values.maskString('a ACCESS-TOKEN-VALUE b REFRESH-TOKEN-VALUE c LIST-TOKEN-VALUE')).toBe(
      'a [REDACTED:bundle] b [REDACTED:bundle] c [REDACTED:bundle]',
    );
  });

  it('never lets a marker reintroduce another registered secret', () => {
    const values = new SensitiveValues();
    // A variable whose *name* happens to be another variable's value: the
    // marker would otherwise publish `leaksecret` in every masked output.
    values.register('sid', 'leaksecret');
    values.register('leaksecret', 'OTHER-SECRET-VALUE');
    const masked = values.maskString('a leaksecret b OTHER-SECRET-VALUE');
    expect(masked).not.toContain('leaksecret');
    expect(masked).toBe('a [REDACTED:sid] b [REDACTED:***REDACTED***]');
    // The same holds for a name that merely *contains* a registered value…
    const nested = new SensitiveValues();
    nested.register('sid', 'EMBEDDED-SECRET');
    nested.register('prefix-EMBEDDED-SECRET-suffix', 'ANOTHER-SECRET-VALUE');
    expect(nested.maskString('ANOTHER-SECRET-VALUE')).not.toContain('EMBEDDED-SECRET');
    // …and two names carrying each other's values terminate rather than recurse.
    const cyclic = new SensitiveValues();
    cyclic.register('NAME-OF-THE-OTHER-ONE', 'VALUE-OF-THE-FIRST-ONE');
    cyclic.register('VALUE-OF-THE-FIRST-ONE', 'NAME-OF-THE-OTHER-ONE');
    expect(cyclic.maskString('VALUE-OF-THE-FIRST-ONE')).toBe('[REDACTED:***REDACTED***]');
    expect(cyclic.maskString('NAME-OF-THE-OTHER-ONE')).toBe('[REDACTED:***REDACTED***]');
  });

  it('collapses a name whose masking would synthesize another registered secret', () => {
    const values = new SensitiveValues();
    // Masking `AAAAAAAA` inside the variable *name* splices its neighbours
    // around `***REDACTED***`, reproducing the first secret exactly — one
    // longest-first pass is not enough, so a name that still contains anything
    // registered is collapsed wholesale.
    values.register('spliced', `pre${REDACTED}post`);
    values.register('inner', 'AAAAAAAA');
    values.register('preAAAAAAAApost', 'THIRD-SECRET-VALUE');
    const masked = values.maskString('THIRD-SECRET-VALUE');
    expect(masked).not.toContain(`pre${REDACTED}post`);
    expect(masked).not.toContain('AAAAAAAA');
    expect(masked).toBe('[REDACTED:***REDACTED***]');
  });

  it('walks a circular structure once, registering every reachable scalar', () => {
    const warnings: string[] = [];
    const values = new SensitiveValues((message) => warnings.push(message));
    const child: Record<string, unknown> = { refresh_token: 'CYCLIC-REFRESH-VALUE' };
    const bundle: Record<string, unknown> = { access_token: 'CYCLIC-ACCESS-VALUE', child };
    child.parent = bundle; // the cycle a YAML alias can preserve
    bundle.self = bundle;
    expect(() => values.register('bundle', bundle)).not.toThrow();
    expect(values.maskString('a CYCLIC-ACCESS-VALUE b CYCLIC-REFRESH-VALUE')).toBe(
      'a [REDACTED:bundle] b [REDACTED:bundle]',
    );
    // Nothing was missed — every object is walked once — so nothing to warn about.
    expect(warnings).toEqual([]);
  });

  it('stops at the depth cap and warns that values beyond it are unmasked', () => {
    const warnings: string[] = [];
    const values = new SensitiveValues((message) => warnings.push(message));
    // A chain deeper than the cap: the shallow token registers, the deep one
    // is out of reach and must be announced rather than silently skipped.
    let node: Record<string, unknown> = { deep: 'DEEP-TOKEN-VALUE' };
    for (let i = 0; i < 40; i++) node = { nested: node };
    node.shallow = 'SHALLOW-TOKEN-VALUE';
    values.register('deepBundle', node);
    expect(values.maskString('SHALLOW-TOKEN-VALUE')).toBe('[REDACTED:deepBundle]');
    expect(values.maskString('DEEP-TOKEN-VALUE')).toBe('DEEP-TOKEN-VALUE'); // beyond the cap
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'deepBundle'");
    expect(warnings[0]).toMatch(/too deeply nested or too large/);
    expect(warnings[0]).not.toContain('DEEP-TOKEN-VALUE');
  });

  it('stops at the node cap and warns', () => {
    const warnings: string[] = [];
    const values = new SensitiveValues((message) => warnings.push(message));
    // Zero-padded so no value is a prefix of another — otherwise a registered
    // early index would mask a later one by substring and blur the assertion.
    const wide = Array.from(
      { length: 20_000 },
      (_, index) => `WIDE-TOKEN-VALUE-${String(index).padStart(5, '0')}`,
    );
    values.register('wide', wide);
    expect(values.maskString('WIDE-TOKEN-VALUE-00000')).toBe('[REDACTED:wide]');
    expect(values.maskString('WIDE-TOKEN-VALUE-19999')).toBe('WIDE-TOKEN-VALUE-19999');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/too deeply nested or too large/);
  });

  it('registers the scalar elements of an array (a wildcard extraction)', () => {
    const values = new SensitiveValues();
    values.register('tokens', ['FIRST-TOKEN-VALUE', 'SECOND-TOKEN-VALUE']);
    expect(values.maskString('a FIRST-TOKEN-VALUE b SECOND-TOKEN-VALUE')).toBe(
      'a [REDACTED:tokens] b [REDACTED:tokens]',
    );
  });

  it('masks structurally — nested values, object keys, and numeric scalars', () => {
    const values = new SensitiveValues();
    values.register('sid', 'SECRET-SESSION-VALUE');
    values.register('pin', 12345678);
    expect(
      values.maskValue({
        'SECRET-SESSION-VALUE': [{ auth: 'Bearer SECRET-SESSION-VALUE' }, 12345678, 42],
        other: 'kept',
      }),
    ).toEqual({
      '[REDACTED:sid]': [{ auth: 'Bearer [REDACTED:sid]' }, '[REDACTED:pin]', 42],
      other: 'kept',
    });
  });

  it('renders a cycle as a note while masking the rest, and keeps a shared child twice', () => {
    const values = new SensitiveValues();
    values.register('sid', 'SECRET-SESSION-VALUE');
    const node: Record<string, unknown> = { token: 'SECRET-SESSION-VALUE' };
    node.self = node; // a container reachable from itself
    const shared = { token: 'SECRET-SESSION-VALUE' };
    const masked = values.maskValue({ node, a: shared, b: shared }) as Record<
      string,
      Record<string, unknown>
    >;
    expect(masked.node.token).toBe('[REDACTED:sid]');
    expect(masked.node.self).toBe(CIRCULAR_NOTE);
    // A child merely *shared* between two positions is ordinary data: it is not
    // a cycle, so both positions render in full.
    expect(masked.a).toEqual({ token: '[REDACTED:sid]' });
    expect(masked.b).toEqual({ token: '[REDACTED:sid]' });
  });

  it('masks a mismatch end to end (path, message, expected, actual)', () => {
    const values = new SensitiveValues();
    values.register('sid', 'SECRET-SESSION-VALUE');
    const [masked] = maskMismatches(
      [
        {
          path: '$.SECRET-SESSION-VALUE',
          kind: 'value',
          expected: 'SECRET-SESSION-VALUE',
          actual: { nested: 'Bearer SECRET-SESSION-VALUE' },
          message: 'value differs from SECRET-SESSION-VALUE',
        },
      ],
      values,
    );
    expect(JSON.stringify(masked)).not.toContain('SECRET-SESSION-VALUE');
    expect(masked.path).toBe('$.[REDACTED:sid]');
    expect(masked.expected).toBe('[REDACTED:sid]');
    expect(masked.message).toBe('value differs from [REDACTED:sid]');
    expect(sensitiveMarker('sid')).toBe('[REDACTED:sid]');
  });

  it('leaves an absent expected/actual absent rather than inventing one', () => {
    const values = new SensitiveValues();
    values.register('sid', 'SECRET-SESSION-VALUE');
    const [masked] = maskMismatches(
      [{ path: '$.a', kind: 'missing', expected: 'SECRET-SESSION-VALUE', message: 'missing' }],
      values,
    );
    expect(masked.actual).toBeUndefined();
    expect(masked.expected).toBe('[REDACTED:sid]');
  });
});

// --- End-to-end propagation through a real scenario run ---------------------

let newServer: TestServer | undefined;
let legacyServer: TestServer | undefined;
let reportDir: string;

beforeEach(() => {
  reportDir = mkdtempSync(join(tmpdir(), 'pharos-sensitive-'));
});

afterEach(async () => {
  await newServer?.close();
  await legacyServer?.close();
  newServer = undefined;
  legacyServer = undefined;
});

function config(overrides: Partial<PharosConfig> = {}): PharosConfig {
  return {
    ...defaultConfig(),
    legacy_base_url: legacyServer?.url,
    new_base_url: newServer?.url,
    report_dir: reportDir,
    fixture_dir: reportDir,
    ...overrides,
  };
}

const registry = new ContractRegistry();

function readArtifacts(scenarioId: string, stepId: string): string {
  const dir = join(reportDir, 'artifacts', scenarioId, stepId);
  return readdirSync(dir)
    .map((file) => readFileSync(join(dir, file), 'utf8'))
    .join('\n');
}

/** A cookie value with characters that percent- and form-encode differently. */
const SESSION = 'SUP3R/SECRET+SESSION=';

/**
 * The common fixture: `/login` hands out `sid=<SESSION>`, every other path
 * answers 200 with a JSON body (and echoes what it was sent, so a secret that
 * reached the wire also reaches the response — the harshest case for masking).
 */
async function loginServer(): Promise<TestServer> {
  return startTestServer((request, response) => {
    if (request.url === '/login') {
      response.setHeader('set-cookie', [`sid=${SESSION}; Path=/`]);
      replyJson(response, 200, { ok: true });
      return;
    }
    replyJson(response, 200, {
      echoed: request.body,
      header: request.headers['x-session'] ?? null,
    });
  });
}

/** `login` (extracting the cookie into `sid`) followed by a step that is made to fail. */
function loginThen(id: string, secondStep: string) {
  return loadScenarioFromText(
    `version: 1
id: ${id}
name: ${id}
service: s
tags: [smoke]
mode: new_only_assert
steps:
  - id: login
    request: { method: POST, path: /login, body: { user: u } }
    extract:
      sid: { from: response.set_cookie, path: sid }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
${secondStep}`,
    'test.yaml',
  );
}

describe('sensitivity propagation — failure artifacts', () => {
  it('masks an extracted cookie substituted into a later JSON body field', async () => {
    newServer = await loginServer();
    const scenario = loginThen(
      'prop.body',
      `  - id: use
    request:
      method: POST
      path: /echo
      body: { token: "{{ variables.sid }}", nested: { again: "{{ variables.sid }}" } }
    compare: { strategy: explicit_expectations, expect: { status: 418 } }`,
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(false);
    // The request really did carry the secret…
    expect(newServer.requests[1].body).toContain(SESSION);
    const artifacts = readArtifacts('prop.body', 'use');
    expect(artifacts).not.toContain(SESSION);
    expect(artifacts).toContain('[REDACTED:sid]');
  });

  it('masks an extracted cookie in a custom header no static list names', async () => {
    newServer = await loginServer();
    const scenario = loginThen(
      'prop.header',
      `  - id: use
    request:
      method: GET
      path: /echo
      headers: { X-Session: "{{ variables.sid }}" }
    compare: { strategy: explicit_expectations, expect: { status: 418 } }`,
    );
    // An empty static redaction config: only value-based masking can save this.
    const result = await runScenario(
      scenario,
      'test.yaml',
      config({ redaction: { headers: [], json_paths: [], query_params: [] } }),
      registry,
    );
    expect(result.pass).toBe(false);
    expect(newServer.requests[1].headers['x-session']).toBe(SESSION);
    const artifacts = readArtifacts('prop.header', 'use');
    expect(artifacts).not.toContain(SESSION);
    expect(artifacts).toContain('[REDACTED:sid]');
  });

  it('masks a secret embedded in a composite header value, keeping the prefix', async () => {
    newServer = await loginServer();
    const scenario = loginThen(
      'prop.bearer',
      `  - id: use
    request:
      method: GET
      path: /echo
      headers: { X-Auth: "Bearer {{ variables.sid }}" }
    compare: { strategy: explicit_expectations, expect: { status: 418 } }`,
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(false);
    expect(newServer.requests[1].headers['x-auth']).toBe(`Bearer ${SESSION}`);
    const artifacts = readArtifacts('prop.bearer', 'use');
    expect(artifacts).not.toContain(SESSION);
    expect(artifacts).toContain('Bearer [REDACTED:sid]');
  });

  it('masks a secret in a urlencoded form body, encoded form included', async () => {
    newServer = await loginServer();
    const scenario = loginThen(
      'prop.form',
      `  - id: use
    request:
      method: POST
      path: /token
      form: { grant_type: authorization_code, session: "{{ variables.sid }}" }
    compare: { strategy: explicit_expectations, expect: { status: 418 } }`,
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(false);
    // The wire carried the urlencoded secret — substitution is untouched.
    const sent = new URLSearchParams(newServer.requests[1].body);
    expect(sent.get('session')).toBe(SESSION);
    expect(newServer.requests[1].body).toContain('SUP3R%2FSECRET%2BSESSION%3D');
    const artifacts = readArtifacts('prop.form', 'use');
    expect(artifacts).not.toContain(SESSION);
    // Neither the raw value nor either encoding of it reaches disk.
    expect(artifacts).not.toContain(encodeURIComponent(SESSION));
    expect(artifacts).not.toContain(new URLSearchParams({ v: SESSION }).toString().slice(2));
    expect(artifacts).toContain('[REDACTED:sid]');
  });

  it('names the first-registered variable when two extractions share a value', async () => {
    newServer = await loginServer();
    const scenario = loadScenarioFromText(
      `version: 1
id: prop.shared
name: shared
service: s
tags: [smoke]
mode: new_only_assert
steps:
  - id: login
    request: { method: POST, path: /login, body: { user: u } }
    extract:
      sidA: { from: response.set_cookie, path: sid }
      sidB: { from: response.set_cookie, path: sid }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
  - id: use
    request:
      method: POST
      path: /echo
      body: { a: "{{ variables.sidA }}", b: "{{ variables.sidB }}" }
    compare: { strategy: explicit_expectations, expect: { status: 418 } }
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(false);
    const artifacts = readArtifacts('prop.shared', 'use');
    expect(artifacts).not.toContain(SESSION);
    // Deterministic: the first registration owns the marker for both fields.
    expect(artifacts).toContain('[REDACTED:sidA]');
    expect(artifacts).not.toContain('[REDACTED:sidB]');
  });

  it('masks every leaf of an object-valued sensitive extraction', async () => {
    // The container is what the rule names; registering only the container
    // would register nothing at all and leave every token inside it live.
    const access = `ACCESS-${'x9'.repeat(30)}`;
    const refresh = `REFRESH-${'y7'.repeat(30)}`;
    newServer = await startTestServer((request, response) => {
      if (request.url === '/login') {
        replyJson(response, 200, { bundle: { access_token: access, meta: { refresh } } });
        return;
      }
      replyJson(response, 200, { echoed: request.body });
    });
    const scenario = loadScenarioFromText(
      `version: 1
id: prop.bundle
name: bundle
service: s
tags: [smoke]
mode: new_only_assert
steps:
  - id: login
    request: { method: POST, path: /login }
    extract:
      bundle: { from: response.body, path: $.bundle, sensitive: true }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
  - id: use
    request:
      method: POST
      path: /echo
      body: { bundle: "{{ variables.bundle }}" }
    compare:
      strategy: explicit_expectations
      expect:
        body:
          json_paths:
            $.echoed: "{{ variables.bundle }}"
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(false);
    // The request really did carry both tokens, nested inside the object.
    expect(newServer.requests[1].body).toContain(access);
    const diffText = result.steps[1].comparison?.diffText ?? '';
    const artifacts = readArtifacts('prop.bundle', 'use');
    for (const surface of [diffText, artifacts, JSON.stringify(result.steps[1].comparison)]) {
      expect(surface).not.toContain(access);
      expect(surface).not.toContain(refresh);
      expect(surface).not.toContain('x9x9x9');
      expect(surface).not.toContain('y7y7y7');
      expect(surface).toContain('[REDACTED:bundle]');
    }
  });

  it('masks a body value only when the extract rule declares it sensitive', async () => {
    newServer = await startTestServer((request, response) => {
      if (request.url === '/login') {
        replyJson(response, 200, { access_token: 'BODY-ACCESS-TOKEN-VALUE', plain: 'PLAIN-VALUE' });
        return;
      }
      replyJson(response, 200, { ok: true });
    });
    const scenario = loadScenarioFromText(
      `version: 1
id: prop.bodyflag
name: bodyflag
service: s
tags: [smoke]
mode: new_only_assert
steps:
  - id: login
    request: { method: POST, path: /login }
    extract:
      accessToken: { from: response.body, path: $.access_token, sensitive: true }
      plain: { from: response.body, path: $.plain }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
  - id: use
    request:
      method: POST
      path: /echo
      body: { token: "{{ variables.accessToken }}", plain: "{{ variables.plain }}" }
    compare: { strategy: explicit_expectations, expect: { status: 418 } }
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(false);
    const artifacts = readArtifacts('prop.bodyflag', 'use');
    expect(artifacts).not.toContain('BODY-ACCESS-TOKEN-VALUE');
    expect(artifacts).toContain('[REDACTED:accessToken]');
    // The control: an unflagged body extraction is ordinary data, not a secret.
    expect(artifacts).toContain('PLAIN-VALUE');
  });
});

describe('sensitivity propagation — mismatches and diff text', () => {
  it('masks an expectation literal carrying an extracted secret', async () => {
    newServer = await loginServer();
    const scenario = loginThen(
      'prop.expect',
      `  - id: assert
    request: { method: POST, path: /echo, body: { v: 1 } }
    compare:
      strategy: explicit_expectations
      expect:
        body:
          json_paths:
            $.header: "{{ variables.sid }}"`,
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(false);
    const comparison = result.steps[1].comparison;
    expect(JSON.stringify(comparison)).not.toContain(SESSION);
    expect(comparison?.mismatches[0]?.expected).toBe('[REDACTED:sid]');
    expect(comparison?.diffText).toContain('[REDACTED:sid]');
  });

  it('masks a long token before the diff preview truncates it', async () => {
    const token = `TOK-${'abcdefghij'.repeat(40)}`; // 404 chars, far past the preview bound
    newServer = await startTestServer((request, response) => {
      if (request.url === '/login') {
        response.setHeader('x-token', token);
        replyJson(response, 200, { ok: true });
        return;
      }
      replyJson(response, 200, { value: 'something-else' });
    });
    const scenario = loadScenarioFromText(
      `version: 1
id: prop.preview
name: preview
service: s
tags: [smoke]
mode: new_only_assert
steps:
  - id: login
    request: { method: POST, path: /login }
    extract:
      token: { from: response.headers, path: x-token }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
  - id: assert
    request: { method: GET, path: /echo }
    compare:
      strategy: explicit_expectations
      expect:
        body:
          json_paths:
            $.value: "{{ variables.token }}"
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    expect(result.pass).toBe(false);
    const diffText = result.steps[1].comparison?.diffText ?? '';
    expect(diffText).toContain('[REDACTED:token]');
    // Not even a truncated prefix of the token survives.
    expect(diffText).not.toContain(token.slice(0, 40));
    expect(diffText).not.toContain('abcdefghij');
  });

  it('masks the view a custom comparator is handed', async () => {
    newServer = await startTestServer((request, response) => {
      if (request.url === '/login') {
        response.setHeader('set-cookie', [`sid=${SESSION}; Path=/`]);
        replyJson(response, 200, { ok: true });
        return;
      }
      response.setHeader('x-echo', SESSION);
      replyJson(response, 200, { echoed: SESSION });
    });
    let seen = '';
    const scenario = loginThen(
      'prop.custom',
      `  - id: use
    request: { method: GET, path: /echo }
    compare: { strategy: custom, comparator: peek }`,
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry, {
      comparators: {
        peek: (ctx) => {
          seen = JSON.stringify(ctx.candidate);
          return [
            {
              path: '$.echoed',
              kind: 'custom',
              expected: 'nothing',
              // A comparator echoing its own view back into a mismatch cannot
              // leak either — the view it was handed is already masked.
              actual: (ctx.candidate.bodyJson as { echoed: string }).echoed,
              message: 'comparator saw a body',
            },
          ];
        },
      },
    });
    expect(result.pass).toBe(false);
    expect(seen).not.toContain(SESSION);
    expect(seen).toContain('[REDACTED:sid]');
    expect(JSON.stringify(result.steps[1].comparison)).not.toContain(SESSION);
  });

  it('survives a comparator returning a self-referencing mismatch value', async () => {
    newServer = await loginServer();
    const scenario = loginThen(
      'prop.cyclic',
      `  - id: use
    request: { method: GET, path: /echo }
    compare: { strategy: custom, comparator: cyclic }`,
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry, {
      comparators: {
        // Nothing constrains a comparator's mismatch values to be acyclic; an
        // unguarded mask would recurse until the stack died, taking the whole
        // comparison result with it.
        cyclic: () => {
          const expected: Record<string, unknown> = { session: SESSION };
          expected.self = expected;
          return [
            { path: '$.session', kind: 'custom', expected, actual: 'other', message: 'differs' },
          ];
        },
      },
    });
    expect(result.pass).toBe(false);
    // The result survived intact — the mismatch is still there, masked…
    const mismatch = result.steps[1].comparison?.mismatches[0];
    expect(mismatch?.message).toBe('differs');
    expect(mismatch?.expected).toEqual({ session: '[REDACTED:sid]', self: CIRCULAR_NOTE });
    // …and rendering it does not throw on the cycle either.
    expect(result.steps[1].comparison?.diffText).toContain('[REDACTED:sid]');
    expect(JSON.stringify(result.steps[1].comparison)).not.toContain(SESSION);
  });
});

describe('sensitivity propagation — execution errors', () => {
  it('masks a secret carried in the URL of a timeout error', async () => {
    let pending: ServerResponse | undefined;
    newServer = await startTestServer((request, response) => {
      if (request.url === '/login') {
        response.setHeader('set-cookie', [`sid=${SESSION}; Path=/`]);
        replyJson(response, 200, { ok: true });
        return;
      }
      pending = response; // never answered: the client must time out
    });
    const scenario = loginThen(
      'prop.timeout',
      `  - id: slow
    request:
      method: GET
      path: /slow
      query: { token: "{{ variables.sid }}" }
      timeoutMs: 120
    compare: { strategy: explicit_expectations, expect: { status: 200 } }`,
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry);
    pending?.end();
    expect(result.pass).toBe(false);
    const error = result.steps[1].error ?? '';
    expect(error).toMatch(/timed out/);
    // The URL in the message carried the secret percent-encoded by `buildUrl`.
    expect(error).not.toContain(SESSION);
    expect(error).not.toContain(encodeURIComponent(SESSION));
    expect(error).not.toContain('SUP3R');
    expect(error).toContain('[REDACTED:sid]');
  });

  it('masks a secret an after hook puts into its error message', async () => {
    newServer = await loginServer();
    const scenario = loadScenarioFromText(
      `version: 1
id: prop.hookerror
name: hookerror
service: s
tags: [smoke]
mode: new_only_assert
steps:
  - id: login
    request: { method: POST, path: /login, body: { user: u } }
    extract:
      sid: { from: response.set_cookie, path: sid }
    compare: { strategy: explicit_expectations, expect: { status: 200 } }
    after:
      hooks: [{ name: boom }]
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry, {
      hooks: {
        boom: (ctx) => {
          throw new Error(`hook failed with session ${String(ctx.variables.sid)}`);
        },
      },
    });
    expect(result.pass).toBe(false);
    expect(result.steps[0].error).not.toContain(SESSION);
    expect(result.steps[0].error).toContain('[REDACTED:sid]');
  });
});

describe('sensitivity propagation — recordings', () => {
  it('masks an extracted secret on both the request and response side of a fixture', async () => {
    legacyServer = await startTestServer((request, response) => {
      if (request.url === '/login') {
        response.setHeader('set-cookie', [`sid=${SESSION}; Path=/`]);
        replyJson(response, 200, { ok: true });
        return;
      }
      // The legacy service reflects the secret back: header, cookie, and body.
      response.setHeader('set-cookie', [`sid=${SESSION}; Path=/`]);
      response.setHeader('x-session', request.headers['x-session'] ?? '');
      replyJson(response, 200, { echoed: request.headers['x-session'] ?? null });
    });
    const scenario = loadScenarioFromText(
      `version: 1
id: prop.record
name: record
service: s
tags: [recording]
mode: legacy_record
steps:
  - id: login
    request: { method: POST, path: /login, body: { user: u } }
    extract:
      sid: { from: legacy.set_cookie, path: sid }
    recording: { fixture: login.json, safe_headers: [content-type] }
  - id: use
    request:
      method: POST
      path: /echo
      headers: { X-Session: "{{ variables.sid }}" }
      body: { token: "{{ variables.sid }}" }
    recording:
      fixture: use.json
      safe_headers: [content-type, x-session, set-cookie]
`,
      'test.yaml',
    );
    const result = await runScenario(scenario, 'test.yaml', config(), registry, {
      recordingEnabled: true,
    });
    expect(result.pass).toBe(true);
    const fixture = readFileSync(join(reportDir, 'use.json'), 'utf8');
    expect(fixture).not.toContain(SESSION);
    expect(fixture).not.toContain(encodeURIComponent(SESSION));
    const recorded = JSON.parse(fixture);
    // Request side: the header and the body field that carried the secret.
    expect(recorded.request.headers['X-Session']).toBe('[REDACTED:sid]');
    expect(recorded.request.body).toEqual({ token: '[REDACTED:sid]' });
    // Response side: the echoed header, the declared-safe Set-Cookie, and the
    // body (whose cached text is regenerated from the masked JSON).
    expect(recorded.response.headers['x-session']).toBe('[REDACTED:sid]');
    expect(recorded.response.set_cookie).toEqual(['sid=[REDACTED:sid]; Path=/']);
    expect(recorded.response.bodyJson).toEqual({ echoed: '[REDACTED:sid]' });
    expect(recorded.response.bodyText).toBe(JSON.stringify({ echoed: '[REDACTED:sid]' }));
  });
});
