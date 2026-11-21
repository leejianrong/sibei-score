import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pkce, startHosted } from './hosted-support.js';
import type { Hosted } from './hosted-support.js';

/**
 * The OAuth 2.1 authorisation server for the MCP endpoint (V22a, ADR-0034 decision 5): discovery metadata,
 * dynamic client registration, the consent round trip, and the PKCE code exchange that ends in an ordinary
 * V21 token. Everything is over a real socket, because the guards and the public/private split are half of
 * what is being pinned.
 */

let h: Hosted;
beforeEach(async () => {
  h = await startHosted();
});
afterEach(async () => {
  await h.close();
});

const REDIRECT = 'http://127.0.0.1:7777/callback';
const JSON_POST = { 'content-type': 'application/json' };

async function register(extra: Record<string, unknown> = {}) {
  const reply = await h.request('/v1/auth/oauth/register', {
    method: 'POST',
    headers: JSON_POST,
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'Test agent', ...extra }),
  });
  return { reply, clientId: reply.status === 201 ? (reply.json().client_id as string) : '' };
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...extra,
  });
  return `/v1/auth/oauth/authorize?${query.toString()}`;
}

/** Everything the consent page re-sends on approval, lifted from where `authorize` sent the browser. */
function consentParams(location: string): Record<string, string> {
  const url = new URL(location, 'http://x');
  expect(url.pathname).toBe('/');
  expect(url.hash.startsWith('#/authorize?')).toBe(true);
  return Object.fromEntries(new URLSearchParams(url.hash.slice('#/authorize?'.length)));
}

async function approveFlow(cookie: string, clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const authorize = await h.request(authorizeUrl(clientId, challenge, extra));
  expect(authorize.status).toBe(302);
  const params = consentParams(authorize.headers.location!);
  const approve = await h.request('/v1/auth/oauth/approve', {
    method: 'POST',
    headers: { ...JSON_POST, cookie },
    body: JSON.stringify({ ...params, approve: true }),
  });
  expect(approve.status).toBe(200);
  const back = new URL(approve.json().redirectTo as string);
  return { back, code: back.searchParams.get('code')! };
}

const exchange = (form: Record<string, string>) =>
  h.request('/v1/auth/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });

describe('discovery metadata', () => {
  it('names /mcp as the resource and this server as its authorisation server, to a caller with no credential', async () => {
    const reply = await h.request('/.well-known/oauth-protected-resource');
    expect(reply.status).toBe(200);
    expect(reply.json()).toMatchObject({
      resource: 'http://127.0.0.1/mcp',
      authorization_servers: ['http://127.0.0.1'],
      scopes_supported: ['mcp:read', 'mcp:write'],
      bearer_methods_supported: ['header'],
    });
    // The path-suffixed form (RFC 9728 §3.1) says the same.
    expect((await h.request('/.well-known/oauth-protected-resource/mcp')).json().resource).toBe('http://127.0.0.1/mcp');
  });

  it('advertises PKCE S256, public clients, and the three endpoints', async () => {
    const meta = (await h.request('/.well-known/oauth-authorization-server')).json();
    expect(meta).toMatchObject({
      issuer: 'http://127.0.0.1',
      authorization_endpoint: 'http://127.0.0.1/v1/auth/oauth/authorize',
      token_endpoint: 'http://127.0.0.1/v1/auth/oauth/token',
      registration_endpoint: 'http://127.0.0.1/v1/auth/oauth/register',
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      grant_types_supported: ['authorization_code'],
    });
  });

  it('answers only GET, and no CORS headers', async () => {
    const reply = await h.request('/.well-known/oauth-authorization-server', { method: 'POST' });
    expect(reply.status).toBe(405);
    const ok = await h.request('/.well-known/oauth-authorization-server');
    expect(Object.keys(ok.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
  });
});

describe('dynamic client registration', () => {
  it('registers a public client and echoes what it was told', async () => {
    const { reply, clientId } = await register();
    expect(reply.status).toBe(201);
    expect(clientId).toMatch(/^sbc_/);
    expect(reply.json()).toMatchObject({
      client_name: 'Test agent',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
  });

  it.each([
    ['no redirect URIs', { redirect_uris: [] }],
    ['a plain-http redirect to a real host', { redirect_uris: ['http://evil.example/cb'] }],
    ['a javascript: redirect', { redirect_uris: ['javascript:alert(1)'] }],
    ['a redirect with a fragment', { redirect_uris: ['https://app.example/cb#x'] }],
    ['a relative redirect', { redirect_uris: ['/cb'] }],
    ['a confidential client', { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' }],
  ])('refuses %s', async (_label, body) => {
    const reply = await h.request('/v1/auth/oauth/register', { method: 'POST', headers: JSON_POST, body: JSON.stringify(body) });
    expect(reply.status).toBe(400);
    expect(reply.json().error).toMatch(/^invalid_/);
  });

  it('accepts https and a private-use scheme', async () => {
    const reply = await h.request('/v1/auth/oauth/register', {
      method: 'POST',
      headers: JSON_POST,
      body: JSON.stringify({ redirect_uris: ['https://app.example/cb', 'com.example.app:/cb'] }),
    });
    expect(reply.status).toBe(201);
    expect(reply.json().client_name).toBe('An MCP client');
  });
});

describe('authorise and consent', () => {
  it('sends a valid request to the consent page with the parameters it must re-send', async () => {
    const { clientId } = await register();
    const { challenge } = pkce();
    const reply = await h.request(authorizeUrl(clientId, challenge));
    expect(reply.status).toBe(302);
    expect(consentParams(reply.headers.location!)).toEqual({
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge,
      scope: 'mcp:read mcp:write',
      client_name: 'Test agent',
      state: 'xyz',
    });
  });

  it('never redirects to a URI the client did not register, or for an unknown client', async () => {
    const { clientId } = await register();
    const { challenge } = pkce();
    const wrong = await h.request(authorizeUrl(clientId, challenge).replace(encodeURIComponent(REDIRECT), 'http%3A%2F%2F127.0.0.1%3A1%2Fother'));
    expect(wrong.status).toBe(400);
    expect(wrong.headers.location).toBeUndefined();
    const unknown = await h.request(authorizeUrl('sbc_bm90anNvbg', challenge));
    expect(unknown.status).toBe(400);
    expect(unknown.headers.location).toBeUndefined();
  });

  it('reports other faults to the client by redirect: no PKCE, a foreign resource, a scope that is not ours', async () => {
    const { clientId } = await register();
    const { challenge } = pkce();
    const cases: [string, Record<string, string>][] = [
      ['invalid_request', { code_challenge_method: 'plain' }],
      ['invalid_target', { resource: 'https://elsewhere.example/mcp' }],
      ['invalid_scope', { scope: 'read write' }],
      ['unsupported_response_type', { response_type: 'token' }],
    ];
    for (const [error, extra] of cases) {
      const reply = await h.request(authorizeUrl(clientId, challenge, extra));
      expect(reply.status).toBe(302);
      const back = new URL(reply.headers.location!);
      expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
      expect(back.searchParams.get('error')).toBe(error);
      expect(back.searchParams.get('state')).toBe('xyz');
    }
  });

  it('accepts a resource that names /mcp, and a narrower scope', async () => {
    const { clientId } = await register();
    const { challenge } = pkce();
    const reply = await h.request(authorizeUrl(clientId, challenge, { resource: 'http://127.0.0.1/mcp', scope: 'mcp:read' }));
    expect(consentParams(reply.headers.location!).scope).toBe('mcp:read');
  });

  it('approves only for a person signed in by cookie, and never for a token', async () => {
    const { clientId } = await register();
    const { challenge } = pkce();
    const params = consentParams((await h.request(authorizeUrl(clientId, challenge))).headers.location!);
    const body = JSON.stringify({ ...params, approve: true });
    expect((await h.request('/v1/auth/oauth/approve', { method: 'POST', headers: JSON_POST, body })).status).toBe(401);

    // A bearer token — even a good one — is not a person saying yes.
    const { userId } = await h.signIn('alice');
    await h.auth.createToken({ id: 'tok_x', tokenHash: 'a'.repeat(64), userId, name: 'x', scopes: ['read', 'write'], expiresAt: '2999-01-01T00:00:00.000Z' });
    const viaToken = await h.request('/v1/auth/oauth/approve', {
      method: 'POST',
      headers: { ...JSON_POST, authorization: 'Bearer sbs_nope' },
      body,
    });
    expect(viaToken.status).toBe(401);
  });

  it('re-validates on approval, so a forged consent page cannot widen what authorise would have allowed', async () => {
    const { cookie } = await h.signIn('alice');
    const { clientId } = await register();
    const { challenge } = pkce();
    const forged = await h.request('/v1/auth/oauth/approve', {
      method: 'POST',
      headers: { ...JSON_POST, cookie },
      body: JSON.stringify({ client_id: clientId, redirect_uri: 'http://127.0.0.1:1/steal', code_challenge: challenge, approve: true }),
    });
    expect(forged.status).toBe(400);
    const scopes = await h.request('/v1/auth/oauth/approve', {
      method: 'POST',
      headers: { ...JSON_POST, cookie },
      body: JSON.stringify({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, scope: 'read write', approve: true }),
    });
    expect(scopes.status).toBe(400);
  });

  it('turns a refusal into access_denied at the client, with its state and the issuer', async () => {
    const { cookie } = await h.signIn('alice');
    const { clientId } = await register();
    const params = consentParams((await h.request(authorizeUrl(clientId, pkce().challenge))).headers.location!);
    const reply = await h.request('/v1/auth/oauth/approve', {
      method: 'POST',
      headers: { ...JSON_POST, cookie },
      body: JSON.stringify({ ...params, approve: false }),
    });
    const back = new URL(reply.json().redirectTo);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('iss')).toBe('http://127.0.0.1');
    expect(back.searchParams.get('code')).toBeNull();
  });
});

describe('the token exchange', () => {
  async function granted() {
    const { cookie, userId } = await h.signIn('alice');
    const { clientId } = await register();
    const { verifier, challenge } = pkce();
    const { back, code } = await approveFlow(cookie, clientId, challenge);
    return { cookie, userId, clientId, verifier, back, code };
  }

  const form = (g: { clientId: string; verifier: string; code: string }, extra: Record<string, string> = {}) => ({
    grant_type: 'authorization_code',
    code: g.code,
    redirect_uri: REDIRECT,
    client_id: g.clientId,
    code_verifier: g.verifier,
    ...extra,
  });

  it('hands the client its code with state and issuer, then exchanges it for an MCP-scoped V21 token', async () => {
    const g = await granted();
    expect(g.back.searchParams.get('state')).toBe('xyz');
    expect(g.back.searchParams.get('iss')).toBe('http://127.0.0.1');

    const reply = await exchange(form(g, { resource: 'http://127.0.0.1/mcp' }));
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    const body = reply.json();
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toMatch(/^sbs_/);
    expect(body.scope).toBe('mcp:read mcp:write');
    expect(body.expires_in).toBe(90 * 24 * 60 * 60);

    // It is an ordinary V21 token: it is listed under the person's tokens, named for the client, by cookie.
    const listed = (await h.request('/v1/auth/tokens', { headers: { cookie: g.cookie } })).json().tokens;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'Test agent (MCP)', scopes: ['mcp:read', 'mcp:write'] });
    expect(JSON.stringify(listed)).not.toContain(body.access_token);
  });

  it('spends the code: a second exchange is invalid_grant', async () => {
    const g = await granted();
    expect((await exchange(form(g))).status).toBe(200);
    const again = await exchange(form(g));
    expect(again.status).toBe(400);
    expect(again.json().error).toBe('invalid_grant');
  });

  it('checks the PKCE verifier, and a failed attempt still spends the code', async () => {
    const g = await granted();
    const wrong = await exchange(form(g, { code_verifier: pkce().verifier }));
    expect(wrong.status).toBe(400);
    expect(wrong.json().error).toBe('invalid_grant');
    expect((await exchange(form(g))).json().error).toBe('invalid_grant');
  });

  it('checks the redirect URI and the client the code was issued to', async () => {
    const a = await granted();
    expect((await exchange(form(a, { redirect_uri: 'http://127.0.0.1:1/other' }))).json().error).toBe('invalid_grant');
    const b = await granted();
    const other = (await register({ client_name: 'Other' })).clientId;
    expect((await exchange(form(b, { client_id: other }))).json().error).toBe('invalid_grant');
  });

  it('refuses a resource that is not /mcp, a missing verifier and any other grant type', async () => {
    const g = await granted();
    expect((await exchange(form(g, { resource: 'https://elsewhere.example/mcp' }))).json().error).toBe('invalid_target');
    expect((await exchange(form(g, { code_verifier: 'short' }))).json().error).toBe('invalid_request');
    expect((await exchange(form(g, { grant_type: 'client_credentials' }))).json().error).toBe('unsupported_grant_type');
    // None of those spent it.
    expect((await exchange(form(g))).status).toBe(200);
  });

  it('mints only the scopes the person was shown', async () => {
    const { cookie } = await h.signIn('alice');
    const { clientId } = await register();
    const { verifier, challenge } = pkce();
    const { code } = await approveFlow(cookie, clientId, challenge, { scope: 'mcp:read' });
    expect((await exchange({ ...form({ clientId, verifier, code }) })).json().scope).toBe('mcp:read');
  });
});

describe('audience: an MCP token is for /mcp, and only /mcp', () => {
  it('is refused by the /v1/ API by name', async () => {
    const { cookie } = await h.signIn('alice');
    const { clientId } = await register();
    const { verifier, challenge } = pkce();
    const { code } = await approveFlow(cookie, clientId, challenge);
    const token = (await exchange({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier })).json().access_token;

    const reply = await h.request('/v1/scores', { headers: { authorization: `Bearer ${token}` } });
    expect(reply.status).toBe(403);
    expect(reply.json().error.kind).toBe('wrong-audience');
  });

  it('cannot be asked for through the device flow, which mints /v1/ tokens only', async () => {
    const { cookie } = await h.signIn('alice');
    const started = (await h.request('/v1/auth/device', { method: 'POST' })).json();
    const reply = await h.request('/v1/auth/device/approve', {
      method: 'POST',
      headers: { ...JSON_POST, cookie },
      body: JSON.stringify({ userCode: started.userCode, scopes: ['mcp:read'] }),
    });
    expect(reply.status).toBe(422);
  });
});
