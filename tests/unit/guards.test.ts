import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { LOOPBACK, checkHost, checkOrigin, isStateChanging, resolveLocalPrincipal } from '@sibei/api';

/**
 * The boundary guards as pure functions (ADR-0029).
 *
 * `tests/store/api.test.ts` drives them over a real socket, which is where they matter. These are
 * here for the cases the wire cannot reach — Node rejects an HTTP/1.1 request with no Host before
 * the app sees it, so the guard's own branch for that is only checkable from this side — and for
 * the table of hostnames, which is much cheaper to enumerate than to serve.
 */

function request(headers: Record<string, string | undefined>, method = 'POST'): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

describe('the bind address', () => {
  it('is loopback, and it is a constant rather than a parameter', () => {
    // Never 0.0.0.0, including in a compose file, where the default would otherwise expose the port
    // on the host's network. Not being a parameter is what stops anyone passing the wrong one.
    expect(LOOPBACK).toBe('127.0.0.1');
  });
});

describe('which methods are state-changing', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete'])('%s is', (method) => {
    expect(isStateChanging(method)).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS', undefined])('%s is not', (method) => {
    expect(isStateChanging(method)).toBe(false);
  });
});

describe('the Host check', () => {
  it.each(['localhost', 'localhost:5173', '127.0.0.1', '127.0.0.1:8080', '[::1]', '[::1]:8080'])(
    'accepts %s',
    (host) => {
      expect(checkHost(request({ host }))).toEqual({ ok: true });
    },
  );

  it.each([
    'evil.example',
    'evil.example:8080',
    'sibei.localhost.evil.example',
    '127.0.0.1.evil.example',
    '0.0.0.0',
    '192.168.1.10:8080',
  ])('rejects %s', (host) => {
    expect(checkHost(request({ host })).ok).toBe(false);
  });

  it('rejects an absent Host, which is the branch the wire cannot reach', () => {
    expect(checkHost(request({})).ok).toBe(false);
    expect(checkHost(request({ host: '' })).ok).toBe(false);
  });

  it('is case-insensitive, because a header is', () => {
    expect(checkHost(request({ host: 'LOCALHOST:3000' }))).toEqual({ ok: true });
    expect(checkHost(request({ host: 'EVIL.EXAMPLE' })).ok).toBe(false);
  });

  it('says what to do about it rather than only saying no', () => {
    const verdict = checkHost(request({ host: 'evil.example' }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/waits for the hosted version/);
  });
});

describe('the Origin check', () => {
  it('ignores Origin entirely on a read', () => {
    // Origin governs state-changing requests; the Host check is what protects a read.
    expect(checkOrigin(request({ origin: 'https://evil.example' }, 'GET'))).toEqual({ ok: true });
  });

  it.each([
    'http://localhost:5173',
    'http://127.0.0.1:8080',
    'http://localhost',
    'https://127.0.0.1',
  ])('accepts a write from %s', (origin) => {
    expect(checkOrigin(request({ origin }))).toEqual({ ok: true });
  });

  it.each([
    'https://evil.example',
    'http://localhost.evil.example',
    'http://127.0.0.1.evil.example',
    'http://192.168.1.10',
  ])('rejects a write from %s', (origin) => {
    expect(checkOrigin(request({ origin })).ok).toBe(false);
  });

  it('rejects an Origin that is not a URL at all', () => {
    expect(checkOrigin(request({ origin: 'not an origin' })).ok).toBe(false);
  });

  it.each([undefined, '', 'null'])('accepts a write with Origin %s, because that is the CLI', (origin) => {
    // Not a hole. A browser always sends Origin on a cross-origin request, including a form POST and
    // a simple fetch, so absence means the caller is not a browser page. Requiring one would break
    // the CLI — half the intended users (ADR-0002) — while stopping nothing a browser can do.
    expect(checkOrigin(request({ origin }))).toEqual({ ok: true });
  });

  it('does not pin the port, since the dev server and the built UI differ', () => {
    for (const port of ['5173', '4173', '8080']) {
      expect(checkOrigin(request({ origin: `http://localhost:${port}` }))).toEqual({ ok: true });
    }
  });

  it('says why, in terms of what the rule is protecting against', () => {
    const verdict = checkOrigin(request({ origin: 'https://evil.example' }));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/a web page you happen to be visiting/);
  });
});

describe('the auth seam', () => {
  it('resolves every request to local', () => {
    expect(resolveLocalPrincipal(request({}))).toEqual({ owner: 'local' });
  });

  it('is a function, so filling it in later is one change rather than every route', () => {
    expect(typeof resolveLocalPrincipal).toBe('function');
  });
});
