import {
  ApiError,
  CODE_LENGTH,
  DEVICE,
  LIBRARY,
  TOKENS,
  approveDevice,
  formatDay,
  formatTypedCode,
  hashOf,
  isCompleteCode,
  listApiTokens,
  outcomeOfFailure,
  revokeApiToken,
  routeOf,
  toggleScope,
} from '@sibei/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The browser's half of API tokens (V21b): the two routes, what the code field does with what is typed,
 * how the three calls are made, and what a refusal means to the person looking at it. The server's own
 * behaviour is pinned in `tests/api/hosted-auth.test.ts`; this is only what the page does with it.
 */

function stub(status: number, body: unknown = null): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => new Response(body === null ? null : JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the device and tokens routes', () => {
  it('are their own routes and round-trip through the hash', () => {
    expect(routeOf('#/device')).toEqual(DEVICE);
    expect(routeOf('#/tokens')).toEqual(TOKENS);
    expect(hashOf(DEVICE)).toBe('#/device');
    expect(hashOf(TOKENS)).toBe('#/tokens');
    for (const route of [LIBRARY, DEVICE, TOKENS, { view: 'score', id: 'body and soul' } as const]) {
      expect(routeOf(hashOf(route))).toEqual(route);
    }
  });

  it('leave the existing routes alone, and treat anything unknown as the library', () => {
    expect(routeOf('#/score/soul')).toEqual({ view: 'score', id: 'soul' });
    expect(routeOf('')).toEqual(LIBRARY);
    expect(routeOf('#/devices')).toEqual(LIBRARY);
    expect(routeOf('#/device/x')).toEqual(LIBRARY);
  });
});

describe('the code field', () => {
  it.each([
    ['bcdfghjk', 'BCDF-GHJK'],
    ['BCDF-GHJK', 'BCDF-GHJK'],
    ['bcdf ghjk', 'BCDF-GHJK'],
    ['  bcdf-ghjk  ', 'BCDF-GHJK'],
    ['bcdfg', 'BCDF-G'],
    ['bcdf', 'BCDF'],
    ['bc', 'BC'],
    ['', ''],
    ['bcdfghjkmnp', 'BCDF-GHJK'],
    ['b!c@d#f$g', 'BCDF-G'],
  ])('shows %j as %j', (typed, shown) => {
    expect(formatTypedCode(typed)).toBe(shown);
  });

  it('is complete at exactly eight characters, however they were typed, and not before', () => {
    expect(CODE_LENGTH).toBe(8);
    expect(isCompleteCode('BCDF-GHJK')).toBe(true);
    expect(isCompleteCode('bcdfghjk')).toBe(true);
    expect(isCompleteCode('bcdf-ghj')).toBe(false);
    expect(isCompleteCode('')).toBe(false);
  });

  it('never claims to know which characters are valid: that is the server\'s answer', () => {
    // Letters the server's alphabet leaves out (vowels, 0, 1) are accepted here and refused there.
    expect(isCompleteCode('AEIOU011')).toBe(true);
  });
});

describe('dates in the token list', () => {
  it('are a day, in UTC, as `sbscore auth status` prints them', () => {
    expect(formatDay('2026-10-12T00:00:00Z')).toBe('12 Oct 2026');
    expect(formatDay('2027-01-10T23:59:59Z')).toBe('10 Jan 2027');
  });

  it('show what they were given rather than throw on something that is not a date', () => {
    expect(formatDay('soon')).toBe('soon');
  });
});

describe('the scope chips', () => {
  it('toggle independently, in a stable order', () => {
    expect(toggleScope(['read', 'write'], 'write')).toEqual(['read']);
    expect(toggleScope(['read'], 'write')).toEqual(['read', 'write']);
    expect(toggleScope(['write'], 'read')).toEqual(['read', 'write']);
  });

  it('never let the last one go: a token with no scope could do nothing', () => {
    expect(toggleScope(['read'], 'read')).toEqual(['read']);
    expect(toggleScope(['write'], 'write')).toEqual(['write']);
  });
});

describe('approving a device', () => {
  it('posts the code, the name and the scopes, and is done on a 204', async () => {
    const spy = stub(204);
    await expect(approveDevice({ userCode: 'BCDF-GHJK', name: 'my laptop', scopes: ['read'] })).resolves.toBeUndefined();
    const [path, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/v1/auth/device/approve');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ userCode: 'BCDF-GHJK', name: 'my laptop', scopes: ['read'] });
  });

  it('reads an unknown, expired or used code as "not waiting" rather than as a failure', async () => {
    stub(404, { error: { kind: 'unknown-code', message: 'that code is not waiting for approval; it may have expired' } });
    const error = await approveDevice({ userCode: 'BCDF-GHJK', name: 'x', scopes: ['read'] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(outcomeOfFailure(error)).toEqual({ kind: 'not-waiting' });
  });

  it('passes any other refusal through in the server\'s own words', async () => {
    stub(422, { error: { kind: 'invalid-scopes', message: 'scopes must be a non-empty list of: read, write' } });
    const error = await approveDevice({ userCode: 'BCDF-GHJK', name: 'x', scopes: [] }).catch((e: unknown) => e);
    expect(outcomeOfFailure(error)).toEqual({ kind: 'refused', message: 'scopes must be a non-empty list of: read, write' });
  });

  it('says nothing about a failure that was not the API answering (the server being down is not a code problem)', () => {
    expect(outcomeOfFailure(new Error('network'))).toBeNull();
  });
});

describe('listing and revoking tokens', () => {
  it('lists what the server returns', async () => {
    const tokens = [{ id: 'tok_1', name: 'laptop', scopes: ['read'], createdAt: '2026-10-12T00:00:00Z', expiresAt: '2027-01-10T00:00:00Z' }];
    stub(200, { tokens });
    await expect(listApiTokens()).resolves.toEqual(tokens);
  });

  it('revokes by id, encoded, with a DELETE', async () => {
    const spy = stub(204);
    await revokeApiToken('tok_a/b c');
    const [path, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/v1/auth/tokens/tok_a%2Fb%20c');
    expect(init.method).toBe('DELETE');
  });

  it('reports a 404 on revoke (somebody else\'s, or already gone) as an API refusal the page can show', async () => {
    stub(404, { error: { kind: 'no-such-token', message: 'you have no token "x"' } });
    await expect(revokeApiToken('x')).rejects.toMatchObject({ status: 404, kind: 'no-such-token' });
  });
});
