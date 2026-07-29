import { describe, expect, it } from 'vitest';
import { CookieJar, defaultPath, pathMatches } from '../src/execution/cookies';

describe('defaultPath (RFC 6265 Section 5.1.4)', () => {
  it('derives the path from the request URL, not the cookie', () => {
    expect(defaultPath('/api/v1/login')).toBe('/api/v1');
    expect(defaultPath('/users')).toBe('/');
    expect(defaultPath('/')).toBe('/');
    expect(defaultPath('')).toBe('/');
  });

  it('accepts an absolute URL and ignores query/fragment', () => {
    expect(defaultPath('http://127.0.0.1:8080/api/v1/login?next=/home')).toBe('/api/v1');
    expect(defaultPath('/api/v1/login?next=/home#frag')).toBe('/api/v1');
  });
});

describe('pathMatches (RFC 6265 Section 5.1.4)', () => {
  it('matches on an exact path, a prefix at a boundary, and a trailing slash', () => {
    expect(pathMatches('/api', '/api')).toBe(true);
    expect(pathMatches('/api', '/api/v1')).toBe(true);
    expect(pathMatches('/api/', '/api/v1')).toBe(true);
    expect(pathMatches('/', '/anything/at/all')).toBe(true);
  });

  it('does not match a prefix that stops mid-segment', () => {
    expect(pathMatches('/api', '/apiary')).toBe(false);
    expect(pathMatches('/api/v1', '/api')).toBe(false);
  });
});

describe('CookieJar', () => {
  it('applies the default path from the request URL when Set-Cookie has none', () => {
    const jar = new CookieJar();
    jar.ingest(['sid=abc'], 'http://host/api/v1/login');
    expect(jar.cookieHeader('http://host/api/v1/things')).toBe('sid=abc');
    // Default path is /api/v1, so a sibling branch does not receive it.
    expect(jar.cookieHeader('http://host/api/v2/things')).toBeUndefined();
    expect(jar.cookieHeader('http://host/')).toBeUndefined();
  });

  it('sends only path-matching cookies, most-specific-path-first', () => {
    const jar = new CookieJar();
    jar.ingest(
      ['root=r; Path=/', 'api=a; Path=/api', 'deep=d; Path=/api/v1/things'],
      'http://host/login',
    );
    expect(jar.cookieHeader('http://host/api/v1/things/1')).toBe('deep=d; api=a; root=r');
    expect(jar.cookieHeader('http://host/api')).toBe('api=a; root=r');
    expect(jar.cookieHeader('http://host/other')).toBe('root=r');
  });

  it('keys entries by (name, path): same key overwrites, different path coexists', () => {
    const jar = new CookieJar();
    jar.ingest(['sid=first; Path=/'], 'http://host/login');
    jar.ingest(['sid=second; Path=/'], 'http://host/login');
    expect(jar.cookieHeader('http://host/x')).toBe('sid=second');

    jar.ingest(['sid=scoped; Path=/admin'], 'http://host/login');
    expect(jar.cookieHeader('http://host/admin/panel')).toBe('sid=scoped; sid=second');
    expect(jar.cookieHeader('http://host/x')).toBe('sid=second');
  });

  it('keeps a deterministic order for equal-length paths (insertion order)', () => {
    const jar = new CookieJar();
    jar.ingest(['a=1; Path=/x', 'b=2; Path=/y'], 'http://host/login');
    // A last-write-wins replace keeps the original position (Section 5.3 step 11.3).
    jar.ingest(['a=3; Path=/x'], 'http://host/login');
    expect(jar.cookieHeader('http://host/x')).toBe('a=3');
    jar.ingest(['c=4; Path=/'], 'http://host/login');
    expect(jar.cookieHeader('http://host/x')).toBe('a=3; c=4');
  });

  it('deletes a cookie set with Max-Age=0 — the logout idiom', () => {
    const jar = new CookieJar();
    jar.ingest(['sid=live; Path=/'], 'http://host/login');
    expect(jar.cookieHeader('http://host/x')).toBe('sid=live');
    jar.ingest(['sid=; Path=/; Max-Age=0'], 'http://host/logout');
    expect(jar.cookieHeader('http://host/x')).toBeUndefined();
  });

  it('deletes a cookie whose Expires is in the past, and keeps a future one', () => {
    const jar = new CookieJar();
    jar.ingest(['sid=live; Path=/', 'keep=yes; Path=/'], 'http://host/login');
    jar.ingest(
      ['sid=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'keep=yes; Path=/; Max-Age=3600'],
      'http://host/logout',
    );
    expect(jar.cookieHeader('http://host/x')).toBe('keep=yes');
  });

  it('ignores a malformed Max-Age instead of letting it override Expires', () => {
    const past = 'Expires=Thu, 01 Jan 1970 00:00:00 GMT';
    for (const bogus of ['10junk', '1.5', '', ' ', '+5']) {
      const jar = new CookieJar();
      // A valid Max-Age here would keep the cookie alive; an ignored one must
      // fall through to the past Expires and delete it.
      jar.ingest([`sid=x; Path=/; Max-Age=${bogus}; ${past}`], 'http://host/login');
      expect(jar.cookieHeader('http://host/x')).toBeUndefined();
    }
  });

  it('honors a valid Max-Age over Expires, in both directions', () => {
    const past = 'Expires=Thu, 01 Jan 1970 00:00:00 GMT';
    const future = 'Expires=Tue, 19 Jan 2038 03:14:07 GMT';
    const alive = new CookieJar();
    alive.ingest([`sid=x; Path=/; Max-Age=3600; ${past}`], 'http://host/login');
    expect(alive.cookieHeader('http://host/x')).toBe('sid=x');
    // A valid *negative* Max-Age deletes even when Expires is far in the future.
    const dead = new CookieJar();
    dead.ingest([`sid=x; Path=/; Max-Age=-1; ${future}`], 'http://host/login');
    expect(dead.cookieHeader('http://host/x')).toBeUndefined();
  });

  it('drops an entry whose lifetime lapsed while the jar was idle', () => {
    const jar = new CookieJar();
    jar.ingest(['gone=1; Path=/; Max-Age=-1', 'here=1; Path=/'], 'http://host/login');
    expect(jar.cookieHeader('http://host/x')).toBe('here=1');
  });

  it('ignores a malformed Set-Cookie and a non-absolute Path attribute', () => {
    const jar = new CookieJar();
    jar.ingest(['not-a-cookie', '=novalue', 'ok=1; Path=relative'], 'http://host/api/v1/login');
    // The bogus Path falls back to the request's default path.
    expect(jar.cookieHeader('http://host/api/v1/x')).toBe('ok=1');
    expect(jar.cookieHeader('http://host/other')).toBeUndefined();
  });

  it('accepts a bare request path as well as an absolute URL', () => {
    const jar = new CookieJar();
    jar.ingest(['sid=abc'], '/api/v1/login?next=/home');
    expect(jar.cookieHeader('/api/v1/things')).toBe('sid=abc');
  });
});
