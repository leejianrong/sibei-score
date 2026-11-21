import { ApiError, OfflineError, RETURN_KEY, consentFailure, decideAuthorization, describeRequest, hashOf, rememberReturn, routeOf, takeReturn } from '@sibei/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Consenting to an MCP client in the browser (V22a): how the page reads the request it was handed and
 * describes it, how the consent route survives the sign-in round trip, and what it sends the server.
 */

const params = {
  client_id: 'sbc_abc',
  redirect_uri: 'http://127.0.0.1:7777/callback',
  code_challenge: 'x'.repeat(43),
  scope: 'mcp:read',
  client_name: 'Test agent',
  state: 's',
};

afterEach(() => vi.unstubAllGlobals());

describe('describing an authorisation request', () => {
  it('says who is asking, what they get, and where the browser goes next', () => {
    expect(describeRequest(params)).toEqual({
      clientName: 'Test agent',
      destination: '127.0.0.1:7777',
      grants: ['Read your charts'],
    });
  });

  it('names a private-use scheme by its scheme, and defaults the name and the scopes', () => {
    const view = describeRequest({ client_id: 'c', redirect_uri: 'com.example.app:/cb', code_challenge: 'x' });
    expect(view).toEqual({
      clientName: 'An MCP client',
      destination: 'com.example.app:',
      grants: ['Read your charts', 'Create and change your charts'],
    });
  });

  it('declines to describe a request that is missing what a request needs, or whose redirect is not a URL', () => {
    expect(describeRequest({})).toBeNull();
    expect(describeRequest({ ...params, code_challenge: '' })).toBeNull();
    expect(describeRequest({ ...params, redirect_uri: 'not a url' })).toBeNull();
  });
});

describe('the consent route', () => {
  it('round-trips its parameters through the hash', () => {
    const route = routeOf(hashOf({ view: 'authorize', params }));
    expect(route).toEqual({ view: 'authorize', params });
  });

  it('is kept across the sign-in trip, query and all', () => {
    const shelf = new Map<string, string>();
    const storage = {
      getItem: (k: string) => shelf.get(k) ?? null,
      setItem: (k: string, v: string) => void shelf.set(k, v),
      removeItem: (k: string) => void shelf.delete(k),
    };
    const hash = hashOf({ view: 'authorize', params });
    rememberReturn(hash, storage);
    expect(takeReturn(storage)).toBe(hash);
    shelf.set(RETURN_KEY, '//evil.example/?a=b');
    expect(takeReturn(storage)).toBeNull();
  });
});

describe('deciding', () => {
  it('sends the request back with the choice and returns where to navigate', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ redirectTo: 'http://127.0.0.1:7777/callback?code=c' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await decideAuthorization(params, true)).toBe('http://127.0.0.1:7777/callback?code=c');
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/v1/auth/oauth/approve');
    expect(JSON.parse(init.body as string)).toEqual({ ...params, approve: true });
  });

  it('turns a refusal into words about the request or the session, not an error screen', () => {
    expect(consentFailure(new ApiError(401, 'unauthenticated', 'x', undefined))).toMatch(/session ended/);
    expect(consentFailure(new ApiError(400, 'invalid_request', 'x', undefined))).toMatch(/not valid any more/);
    expect(consentFailure(new OfflineError(new Error('down')))).toMatch(/Could not reach/);
  });
});
