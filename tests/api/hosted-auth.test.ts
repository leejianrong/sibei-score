import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, memoryBlobStore } from '@sibei/api';
import type { Api, AuthStore, JobStore, Logger, ScoreStore } from '@sibei/api';
import { openSqliteAuthStore, openSqliteJobStore, openSqliteStore } from '@sibei/api/sqlite';

/**
 * Hosted mode: the GitHub OAuth code flow, the cookie session, and tenancy through it (V20, ADR-0034).
 *
 * GitHub is a **fake that behaves like the real one where it matters**: it is a real HTTP server that
 * issues single-use codes bound to the PKCE challenge it was shown at `/authorize`, and refuses the token
 * exchange when the client secret, the redirect URI or the verifier is wrong. So "PKCE is verified" is
 * not asserted by peeking at a parameter — it is the fake refusing, and this suite watching the API
 * refuse the sign-in because of it. The API is real, on a real socket, because calling a handler directly
 * would skip the guards, which are half of what is being pinned (ADR-0029).
 */

const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret-do-not-log';

interface FakeProfile {
  id: number;
  login: string;
  name: string | null;
}

interface FakeGitHub {
  url: string;
  /** Who the next `/authorize` signs in as — standing in for whoever is at the keyboard. */
  nextUser: FakeProfile;
  /** Every token exchange it was asked for, and how many it honoured. */
  exchanges: { asked: number; honoured: number };
  /** Make the token endpoint fail like an outage. */
  down: boolean;
  /** The last access token it minted, so a test can assert it never surfaces. */
  lastAccessToken: string | undefined;
  lastCode: string | undefined;
  close(): Promise<void>;
}

const ALICE: FakeProfile = { id: 1001, login: 'alice', name: 'Alice A' };
const BOB: FakeProfile = { id: 2002, login: 'bob', name: null };

async function startFakeGitHub(): Promise<FakeGitHub> {
  const codes = new Map<string, { challenge: string; redirectUri: string; user: FakeProfile }>();
  const tokens = new Map<string, FakeProfile>();
  let counter = 0;

  const fake: FakeGitHub = {
    url: '',
    nextUser: ALICE,
    exchanges: { asked: 0, honoured: 0 },
    down: false,
    lastAccessToken: undefined,
    lastCode: undefined,
    close: () => new Promise((done) => server.close(() => done())),
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/login/oauth/authorize') {
      const challenge = url.searchParams.get('code_challenge');
      const redirectUri = url.searchParams.get('redirect_uri');
      if (url.searchParams.get('client_id') !== CLIENT_ID || challenge === null || redirectUri === null) {
        return json(400, { error: 'bad authorize request' });
      }
      if (url.searchParams.get('code_challenge_method') !== 'S256') return json(400, { error: 'S256 only' });
      const code = `code-${++counter}`;
      fake.lastCode = code;
      codes.set(code, { challenge, redirectUri, user: fake.nextUser });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        fake.exchanges.asked++;
        if (fake.down) return json(503, { message: 'down' });
        const form = new URLSearchParams(raw);
        const code = form.get('code') ?? '';
        const issued = codes.get(code);
        // Single use, whatever happens next — a code that was tried is spent.
        codes.delete(code);
        const verifier = form.get('code_verifier') ?? '';
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        if (
          issued === undefined ||
          form.get('client_id') !== CLIENT_ID ||
          form.get('client_secret') !== CLIENT_SECRET ||
          form.get('redirect_uri') !== issued.redirectUri ||
          challenge !== issued.challenge
        ) {
          // GitHub's real behaviour: a refusal is a 200 carrying `error`.
          return json(200, { error: 'bad_verification_code' });
        }
        const accessToken = `gho_fake_${++counter}`;
        tokens.set(accessToken, issued.user);
        fake.lastAccessToken = accessToken;
        fake.exchanges.honoured++;
        json(200, { access_token: accessToken, token_type: 'bearer', scope: 'read:user' });
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/user') {
      const user = tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (user === undefined) return json(401, { message: 'Bad credentials' });
      return json(200, user);
    }
    json(404, {});
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  fake.url = `http://127.0.0.1:${address.port}`;
  return fake;
}

let github: FakeGitHub;
let store: ScoreStore;
let jobs: JobStore;
let auth: AuthStore;
let api: Api;
let base: string;
let port: number;
let logged: string[];
let clock: number;

const blobs = memoryBlobStore();

function recordingLogger(): Logger {
  return {
    request: (line) => void logged.push(JSON.stringify(line)),
    error: (message, error) => void logged.push(`${message} ${error instanceof Error ? error.message : String(error)}`),
  };
}

async function boot(overrides: { publicUrl?: string; sessionTtlMs?: number } = {}): Promise<void> {
  api = createApi({
    store,
    jobs,
    blobs,
    logger: recordingLogger(),
    heartbeatMs: 20,
    hosted: {
      auth,
      publicUrl: overrides.publicUrl ?? 'http://127.0.0.1',
      github: {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        authorizeUrl: `${github.url}/login/oauth/authorize`,
        tokenUrl: `${github.url}/login/oauth/access_token`,
        userUrl: `${github.url}/user`,
      },
      now: () => new Date(clock),
      ...(overrides.sessionTtlMs === undefined ? {} : { sessionTtlMs: overrides.sessionTtlMs }),
    },
  });
  ({ port } = await api.listen(0));
  base = `http://127.0.0.1:${port}`;
}

beforeEach(async () => {
  github = await startFakeGitHub();
  store = openSqliteStore({ filename: ':memory:' });
  jobs = openSqliteJobStore({ filename: ':memory:' });
  auth = openSqliteAuthStore({ filename: ':memory:' });
  logged = [];
  clock = Date.parse('2026-10-01T00:00:00Z');
  await boot();
});

afterEach(async () => {
  await api.close();
  await store.close();
  await jobs.close();
  await auth.close();
  await github.close();
});

// --- a browser, in miniature ------------------------------------------------------------------------

interface Reply {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
  json: () => any;
  cookies: string[];
}

/** A raw request, so `Host` and `Origin` can be set (the fetch spec forbids both). */
function raw(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host ?? `127.0.0.1:${port}`, ...options.headers },
        setHost: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body),
            cookies: res.headers['set-cookie'] ?? [],
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

function cookieValue(cookies: string[], name: string): string | undefined {
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  return found?.slice(name.length + 1).split(';')[0];
}

/** Start sign-in and walk to GitHub's authorize page; returns what the browser would hold. */
async function beginSignIn(user: FakeProfile = ALICE): Promise<{ loginCookie: string; callback: string; state: string }> {
  github.nextUser = user;
  const login = await raw('/v1/auth/github/login');
  expect(login.status).toBe(302);
  const authorize = new URL(login.headers.location!);
  const loginCookie = cookieValue(login.cookies, 'sb_oauth')!;
  // The browser follows the redirect to GitHub, which sends it back with a code.
  const authorized = await fetch(authorize, { redirect: 'manual' });
  expect(authorized.status).toBe(302);
  const callback = authorized.headers.get('location')!;
  return { loginCookie, callback, state: authorize.searchParams.get('state')! };
}

function callbackPath(callback: string): string {
  const url = new URL(callback);
  return url.pathname + url.search;
}

/** The whole flow, as a user: the session cookie header to send afterwards. */
async function signIn(user: FakeProfile = ALICE): Promise<string> {
  const { loginCookie, callback } = await beginSignIn(user);
  const done = await raw(callbackPath(callback), { headers: { cookie: `sb_oauth=${loginCookie}` } });
  expect(done.status).toBe(302);
  expect(done.headers.location).toBe('/');
  return `sb_session=${cookieValue(done.cookies, 'sb_session')!}`;
}

function jsonPost(path: string, body: unknown, cookie: string): Promise<Reply> {
  return raw(path, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const create = (id: string) => ({ operations: [{ type: 'score.create', payload: { id, barCount: 4, title: `Chart ${id}` } }] });

// --- the flow ---------------------------------------------------------------------------------------

describe('the OAuth code flow', () => {
  it('redirects to GitHub with a fresh state and an S256 PKCE challenge, and sets a short-lived login cookie', async () => {
    const reply = await raw('/v1/auth/github/login');
    expect(reply.status).toBe(302);
    const target = new URL(reply.headers.location!);
    expect(target.origin).toBe(github.url);
    expect(target.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(target.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1/v1/auth/github/callback`);
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(target.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The secret never leaves the server, and nor does the verifier (only its hash goes to GitHub).
    expect(reply.headers.location).not.toContain(CLIENT_SECRET);

    const cookie = reply.cookies.find((c) => c.startsWith('sb_oauth='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Path=\/v1\/auth\/github/);
    expect(cookie).toMatch(/Max-Age=600/);
    // The challenge on the URL is the hash of the verifier in the cookie — same attempt, not two.
    const [state, verifier] = cookieValue(reply.cookies, 'sb_oauth')!.split('.');
    expect(state).toBe(target.searchParams.get('state'));
    expect(createHash('sha256').update(verifier!).digest('base64url')).toBe(target.searchParams.get('code_challenge'));
  });

  it('uses a different state and verifier for every attempt', async () => {
    const one = cookieValue((await raw('/v1/auth/github/login')).cookies, 'sb_oauth');
    const two = cookieValue((await raw('/v1/auth/github/login')).cookies, 'sb_oauth');
    expect(one).not.toBe(two);
  });

  it('signs a person in: creates their user, and starts an HttpOnly session that opens the API', async () => {
    const { loginCookie, callback } = await beginSignIn(ALICE);
    const done = await raw(callbackPath(callback), { headers: { cookie: `sb_oauth=${loginCookie}` } });
    expect(done.status).toBe(302);
    expect(done.headers.location).toBe('/');

    const session = done.cookies.find((c) => c.startsWith('sb_session='))!;
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Path=\/;/);
    expect(session).toMatch(/Max-Age=2592000/); // thirty days
    // The login attempt is spent: the cookie that carried it is cleared on the way out.
    expect(done.cookies.find((c) => c.startsWith('sb_oauth='))).toMatch(/Max-Age=0/);
    // No CORS headers, here or anywhere (ADR-0029).
    expect(Object.keys(done.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);

    const cookie = `sb_session=${cookieValue(done.cookies, 'sb_session')!}`;
    const listed = await raw('/v1/scores', { headers: { cookie } });
    expect(listed.status).toBe(200);
    expect(listed.json()).toEqual({ scores: [] });
  });

  it('keys the user by GitHub\'s numeric id, so signing in again is the same user and a rename is not a new one', async () => {
    const first = await signIn(ALICE);
    const owner1 = (await auth.findSession(await hashOf(first), now()))!.userId;
    await jsonPost('/v1/scores', create('soul'), first);

    const second = await signIn({ ...ALICE, login: 'alice-renamed' });
    const owner2 = (await auth.findSession(await hashOf(second), now()))!.userId;
    expect(owner2).toBe(owner1);
    // Same person, so the chart made in the first session is there in the second.
    const listed = await raw('/v1/scores', { headers: { cookie: second } });
    expect(listed.json().scores.map((row: { id: string }) => row.id)).toEqual(['soul']);
    expect(owner1).toMatch(/^usr_/);
  });

  it('stores the session by hash only: the token in the cookie is not in the store', async () => {
    const cookie = await signIn();
    const token = cookie.replace('sb_session=', '');
    expect(await auth.findSession(token, now())).toBeNull();
    expect(await auth.findSession(createHash('sha256').update(token).digest('hex'), now())).not.toBeNull();
  });

  it('never hands GitHub\'s access token, the code or the client secret to the browser or a log', async () => {
    const { loginCookie, callback } = await beginSignIn();
    const done = await raw(callbackPath(callback), { headers: { cookie: `sb_oauth=${loginCookie}` } });
    const everything = JSON.stringify(done.headers) + done.body;
    expect(everything).not.toContain(github.lastAccessToken!);
    expect(everything).not.toContain(CLIENT_SECRET);
    const sessionToken = cookieValue(done.cookies, 'sb_session')!;
    for (const line of logged) {
      expect(line).not.toContain(CLIENT_SECRET);
      expect(line).not.toContain(github.lastAccessToken!);
      expect(line).not.toContain(github.lastCode!);
      expect(line).not.toContain(sessionToken);
      expect(line).not.toContain('state=');
    }
  });
});

describe('state and PKCE are verified, and a bad one is refused', () => {
  it('refuses a callback whose state is not the one this browser started, and never asks GitHub', async () => {
    const { loginCookie, callback } = await beginSignIn();
    const forged = new URL(callback);
    forged.searchParams.set('state', 'not-the-state');
    const reply = await raw(callbackPath(forged.toString()), { headers: { cookie: `sb_oauth=${loginCookie}` } });
    expect(reply.status).toBe(400);
    expect(reply.json().error.kind).toBe('invalid-state');
    expect(github.exchanges.asked).toBe(0);
    expect(cookieValue(reply.cookies, 'sb_session')).toBeUndefined();
  });

  it('refuses a callback from a browser that never started a sign-in (login CSRF)', async () => {
    // An attacker completes the flow with *their* account, then hands the victim the callback URL. The
    // victim's browser holds no login cookie, so there is nothing for the state to match.
    const { callback } = await beginSignIn();
    const reply = await raw(callbackPath(callback));
    expect(reply.status).toBe(400);
    expect(reply.json().error.kind).toBe('invalid-state');
    expect(github.exchanges.asked).toBe(0);
  });

  it('refuses a callback carrying no state at all', async () => {
    const { loginCookie, callback } = await beginSignIn();
    const stripped = new URL(callback);
    stripped.searchParams.delete('state');
    const reply = await raw(callbackPath(stripped.toString()), { headers: { cookie: `sb_oauth=${loginCookie}` } });
    expect(reply.status).toBe(400);
    expect(reply.json().error.kind).toBe('invalid-state');
  });

  it('refuses when the PKCE verifier is not the one the challenge was made from — GitHub rejects the exchange', async () => {
    const { loginCookie, callback, state } = await beginSignIn();
    // State matches (so the API's own check passes), but the verifier is not the original: an attacker
    // who intercepted the code cannot redeem it without the verifier that began the exchange.
    const tampered = `${state}.${'x'.repeat(43)}`;
    expect(tampered).not.toBe(loginCookie);
    const reply = await raw(callbackPath(callback), { headers: { cookie: `sb_oauth=${tampered}` } });
    expect(reply.status).toBe(400);
    expect(reply.json().error.kind).toBe('sign-in-failed');
    expect(github.exchanges.asked).toBe(1);
    expect(github.exchanges.honoured).toBe(0);
    expect(cookieValue(reply.cookies, 'sb_session')).toBeUndefined();
  });

  it('treats a code as single-use: replaying a completed callback signs nobody in again', async () => {
    const { loginCookie, callback } = await beginSignIn();
    const headers = { cookie: `sb_oauth=${loginCookie}` };
    expect((await raw(callbackPath(callback), { headers })).status).toBe(302);
    const replay = await raw(callbackPath(callback), { headers });
    expect(replay.status).toBe(400);
    expect(cookieValue(replay.cookies, 'sb_session')).toBeUndefined();
  });

  it('reports a person declining at GitHub as such, not as a server error', async () => {
    const { loginCookie, state } = await beginSignIn();
    const reply = await raw(`/v1/auth/github/callback?error=access_denied&state=${state}`, {
      headers: { cookie: `sb_oauth=${loginCookie}` },
    });
    expect(reply.status).toBe(400);
    expect(reply.json().error.kind).toBe('sign-in-denied');
  });

  it('answers 502 in its own words when GitHub is down, and leaks nothing about the attempt', async () => {
    const { loginCookie, callback } = await beginSignIn();
    github.down = true;
    const reply = await raw(callbackPath(callback), { headers: { cookie: `sb_oauth=${loginCookie}` } });
    expect(reply.status).toBe(502);
    expect(reply.json().error.kind).toBe('github-unavailable');
    expect(reply.body).not.toContain(CLIENT_SECRET);
    expect(logged.join('\n')).not.toContain(CLIENT_SECRET);
  });
});

// --- sessions ---------------------------------------------------------------------------------------

describe('a missing, unknown or expired session is a 401', () => {
  const PRIVATE = ['/v1/scores', '/v1/scores/soul', '/v1/scores/soul/export', '/v1/scores/soul/events', '/v1/imports'];

  it('refuses every private route with no cookie at all', async () => {
    for (const path of PRIVATE) {
      const reply = await raw(path);
      expect({ path, status: reply.status }).toEqual({ path, status: 401 });
      expect(reply.json().error.kind).toBe('unauthenticated');
    }
    expect((await raw('/v1/scores', { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('refuses a cookie that names no session', async () => {
    expect((await raw('/v1/scores', { headers: { cookie: 'sb_session=made-up-by-an-attacker' } })).status).toBe(401);
  });

  it('refuses a session once it has expired, with no purge needed', async () => {
    await api.close();
    await boot({ sessionTtlMs: 60_000 });
    const cookie = await signIn();
    expect((await raw('/v1/scores', { headers: { cookie } })).status).toBe(200);
    clock += 59_000;
    expect((await raw('/v1/scores', { headers: { cookie } })).status).toBe(200);
    clock += 2_000;
    expect((await raw('/v1/scores', { headers: { cookie } })).status).toBe(401);
  });

  it('ends a session on sign-out: the same cookie is refused afterwards, and signing out twice is fine', async () => {
    const cookie = await signIn();
    const out = await raw('/v1/auth/logout', { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(204);
    expect(out.cookies.find((c) => c.startsWith('sb_session='))).toMatch(/Max-Age=0/);
    expect((await raw('/v1/scores', { headers: { cookie } })).status).toBe(401);
    expect((await raw('/v1/auth/logout', { method: 'POST', headers: { cookie } })).status).toBe(204);
  });

  it('keeps health and the shell public, and nothing else', async () => {
    expect((await raw('/v1/health')).status).toBe(200);
    // A non-/v1 path reaches the asset branch (none configured here, so a plain 404 — not a 401).
    expect((await raw('/index.html')).status).toBe(404);
    expect((await raw('/v1/not-a-route')).status).toBe(401);
  });
});

// --- who am I (V20b) --------------------------------------------------------------------------------

describe('GET /v1/me says who is signed in', () => {
  it('is a 401 with no session, the same answer every private route gives', async () => {
    const reply = await raw('/v1/me');
    expect(reply.status).toBe(401);
    expect(reply.json().error.kind).toBe('unauthenticated');
    expect((await raw('/v1/me', { headers: { cookie: 'sb_session=made-up' } })).status).toBe(401);
  });

  it('returns the signed-in user for a live session, and only what the browser needs', async () => {
    const cookie = await signIn(ALICE);
    const reply = await raw('/v1/me', { headers: { cookie } });
    expect(reply.status).toBe(200);
    const body = reply.json();
    expect(body.mode).toBe('hosted');
    expect(body.user).toEqual({ id: expect.stringMatching(/^usr_/), login: 'alice', name: 'Alice A' });
    // Nothing that identifies the session or the provider account travels with it.
    expect(reply.body).not.toContain(cookie.replace('sb_session=', ''));
    expect(Object.keys(body.user).sort()).toEqual(['id', 'login', 'name']);
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('tells two users apart', async () => {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    expect((await raw('/v1/me', { headers: { cookie: alice } })).json().user.login).toBe('alice');
    const bobMe = (await raw('/v1/me', { headers: { cookie: bob } })).json().user;
    expect(bobMe.login).toBe('bob');
    expect(bobMe.name).toBeNull();
  });

  it('is a 401 again once the session is signed out', async () => {
    const cookie = await signIn();
    expect((await raw('/v1/me', { headers: { cookie } })).status).toBe(200);
    await raw('/v1/auth/logout', { method: 'POST', headers: { cookie } });
    expect((await raw('/v1/me', { headers: { cookie } })).status).toBe(401);
  });

  it('only answers GET', async () => {
    const cookie = await signIn();
    const reply = await raw('/v1/me', { method: 'POST', headers: { cookie }, body: '{}' });
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe('GET');
  });
});

// --- tenancy ----------------------------------------------------------------------------------------

describe('a session for user A cannot reach user B\'s data', () => {
  it('cannot read, edit, delete, export or stream another user\'s score — each is a 404, as if it did not exist', async () => {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    expect((await jsonPost('/v1/scores', create('secret'), alice)).status).toBe(201);

    const read = await raw('/v1/scores/secret', { headers: { cookie: bob } });
    expect(read.status).toBe(404);
    expect((await raw('/v1/scores', { headers: { cookie: bob } })).json()).toEqual({ scores: [] });
    expect((await raw('/v1/scores/secret/export?format=pdf', { headers: { cookie: bob } })).status).toBe(404);
    expect((await raw('/v1/scores/secret/source', { headers: { cookie: bob } })).json()).toEqual(
      (await raw('/v1/scores/no-such-score/source', { headers: { cookie: bob } })).json(),
    );
    const edit = await jsonPost(
      '/v1/scores/secret/ops',
      { operations: [{ type: 'meta.set', payload: { title: 'pwned' } }], expectedVersion: 1 },
      bob,
    );
    expect(edit.status).toBe(404);
    expect((await raw('/v1/scores/secret', { method: 'DELETE', headers: { cookie: bob } })).status).toBe(404);
    // Alice's chart is exactly as she left it.
    const still = await raw('/v1/scores/secret', { headers: { cookie: alice } });
    expect(still.json().score.meta.title).toBe('Chart secret');
    expect(still.json().version).toBe(1);
  });

  it('gives each user their own namespace: both can have a chart called "soul"', async () => {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    expect((await jsonPost('/v1/scores', create('soul'), alice)).status).toBe(201);
    // Not a 409: that id exists in someone else's library, which is none of Bob's business.
    expect((await jsonPost('/v1/scores', create('soul'), bob)).status).toBe(201);
  });

  it('cannot open another user\'s event stream, and does not hear their edits on its own', async () => {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    await jsonPost('/v1/scores', create('secret'), alice);

    const denied = await raw('/v1/scores/secret/events', { headers: { cookie: bob } });
    expect(denied.status).toBe(404);
    expect(denied.body).not.toContain('event: changed');

    // Alice's own stream opens, and carries her chart's version.
    const first = await firstFrame('/v1/scores/secret/events', alice);
    expect(first.status).toBe(200);
    expect(first.text).toContain('event: changed');
    // And none of that was visible to the signed-out.
    expect((await raw('/v1/scores/secret/events')).status).toBe(401);
  });

  it('cannot read another user\'s import job, its progress stream, or its retained scan (the blob)', async () => {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    const aliceId = (await auth.findSession(await hashOf(alice), now()))!.userId;
    const scan = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
    await blobs.put('import-source:alice-page-1', scan);
    const job = await jobs.create(aliceId, ['import-source:alice-page-1']);

    // Hosted here has no worker, so the job stays queued — which is all that is needed to be someone's.
    const own = await raw(`/v1/imports/${job.id}/images/0`, { headers: { cookie: alice } });
    expect(own.status).toBe(200);

    for (const path of [`/v1/imports/${job.id}`, `/v1/imports/${job.id}/images/0`, `/v1/imports/${job.id}/events`]) {
      const reply = await raw(path, { headers: { cookie: bob } });
      expect({ path, status: reply.status }).toEqual({ path, status: 404 });
    }
    expect((await raw('/v1/imports', { headers: { cookie: bob } })).json()).toEqual({ jobs: [] });
  });
});

// --- guards and configuration -----------------------------------------------------------------------

describe('the ADR-0029 guards still hold in hosted mode', () => {
  it('rejects a foreign Host, even to the auth routes', async () => {
    const reply = await raw('/v1/auth/github/login', { host: 'evil.example' });
    expect(reply.status).toBe(403);
    expect(reply.json().error.kind).toBe('foreign-host');
  });

  it('rejects a cross-origin state-changing request, even with a valid session', async () => {
    const cookie = await signIn();
    const reply = await raw('/v1/auth/logout', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(reply.status).toBe(403);
    expect(reply.json().error.kind).toBe('foreign-origin');
    // ...and the session is intact: the refused sign-out did not sign anybody out.
    expect((await raw('/v1/scores', { headers: { cookie } })).status).toBe(200);
  });

  it('admits the deployment\'s own host and origin, and only those', async () => {
    await api.close();
    await boot({ publicUrl: 'https://sibei.example' });
    // The Host the proxy forwards is the public one.
    const own = await raw('/v1/health', { host: 'sibei.example' });
    expect(own.status).toBe(200);
    const sameOrigin = await raw('/v1/scores', {
      method: 'POST',
      host: 'sibei.example',
      headers: { origin: 'https://sibei.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(sameOrigin.status).toBe(401); // past the guards; refused for having no session
    // A page on someone's localhost is not the deployment's own origin.
    const local = await raw('/v1/scores', {
      method: 'POST',
      host: 'sibei.example',
      headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(local.status).toBe(403);
  });

  it('marks the cookies Secure when the deployment is https', async () => {
    await api.close();
    await boot({ publicUrl: 'https://sibei.example' });
    const reply = await raw('/v1/auth/github/login', { host: 'sibei.example' });
    expect(reply.cookies.find((c) => c.startsWith('sb_oauth='))).toMatch(/; Secure/);
    expect(new URL(reply.headers.location!).searchParams.get('redirect_uri')).toBe(
      'https://sibei.example/v1/auth/github/callback',
    );
  });

  it('refuses to start with a plain-http public URL that is not loopback', () => {
    expect(() =>
      createApi({
        store,
        hosted: {
          auth,
          publicUrl: 'http://sibei.example',
          github: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
        },
      }),
    ).toThrow(/https/);
  });

  it('refuses a hosted config that also brings its own authenticator', () => {
    expect(() =>
      createApi({
        store,
        authenticate: async () => ({ owner: 'x' }),
        hosted: { auth, publicUrl: 'https://s.example', github: { clientId: 'a', clientSecret: 'b' } },
      }),
    ).toThrow(/one or the other/);
  });
});

describe('local mode is untouched when there is no hosted configuration', () => {
  it('resolves every request to the local principal, with no sign-in and no auth routes', async () => {
    const localStore = openSqliteStore({ filename: ':memory:' });
    const local = createApi({ store: localStore, logger: recordingLogger() });
    const { port: localPort } = await local.listen(0);
    try {
      const listed = await fetch(`http://127.0.0.1:${localPort}/v1/scores`);
      expect(listed.status).toBe(200);
      const created = await fetch(`http://127.0.0.1:${localPort}/v1/scores`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(create('soul')),
      });
      expect(created.status).toBe(201);
      expect((await localStore.list('local')).map((row) => row.id)).toEqual(['soul']);
      // `/v1/me` answers, with nobody to name: local mode has no accounts, and a browser needs to know that.
      const me = await fetch(`http://127.0.0.1:${localPort}/v1/me`);
      expect(me.status).toBe(200);
      expect(await me.json()).toEqual({ mode: 'local' });
      // The sign-in routes do not exist, rather than existing and failing.
      expect((await fetch(`http://127.0.0.1:${localPort}/v1/auth/github/login`, { redirect: 'manual' })).status).toBe(404);
    } finally {
      await local.close();
      await localStore.close();
    }
  });
});

// --- API tokens and the device flow (V21a) ----------------------------------------------------------

interface Minted {
  token: string;
  tokenId: string;
  deviceCode: string;
  userCode: string;
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** Start a device authorisation as the CLI would. */
async function startDevice(): Promise<{ deviceCode: string; userCode: string; reply: Reply }> {
  const reply = await raw('/v1/auth/device', { method: 'POST' });
  expect(reply.status).toBe(200);
  const body = reply.json();
  return { deviceCode: body.deviceCode, userCode: body.userCode, reply };
}

const approve = (cookie: string, body: unknown): Promise<Reply> => jsonPost('/v1/auth/device/approve', body, cookie);
const poll = (deviceCode: string): Promise<Reply> =>
  raw('/v1/auth/device/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceCode }),
  });

/** The whole device flow, as a CLI and the person at the keyboard: a token for whoever holds `cookie`. */
async function mint(cookie: string, approval: Record<string, unknown> = {}): Promise<Minted> {
  const { deviceCode, userCode } = await startDevice();
  expect((await approve(cookie, { userCode, ...approval })).status).toBe(204);
  const collected = await poll(deviceCode);
  expect(collected.status).toBe(200);
  const body = collected.json();
  return { token: body.accessToken, tokenId: body.tokenId, deviceCode, userCode };
}

describe('the device authorisation flow', () => {
  it('starts with a device code the CLI keeps and a short user code a person types, and says where', async () => {
    const { reply, userCode, deviceCode } = await startDevice();
    const body = reply.json();
    expect(userCode).toMatch(/^[BCDFGHJKMNPQRSTVWXYZ2-9]{4}-[BCDFGHJKMNPQRSTVWXYZ2-9]{4}$/);
    expect(deviceCode.length).toBeGreaterThanOrEqual(40);
    expect(body.verificationUri).toBe('http://127.0.0.1/#/device');
    expect(body.expiresIn).toBe(600);
    expect(body.interval).toBe(5);
    expect(reply.headers['cache-control']).toBe('no-store');
  });

  it('keeps two attempts apart: no two codes alike', async () => {
    const a = await startDevice();
    const b = await startDevice();
    expect(a.deviceCode).not.toBe(b.deviceCode);
    expect(a.userCode).not.toBe(b.userCode);
  });

  it('answers a poll as pending until a signed-in person approves, then hands over a token', async () => {
    const cookie = await signIn(ALICE);
    const { deviceCode, userCode } = await startDevice();
    const pending = await poll(deviceCode);
    expect(pending.status).toBe(400);
    expect(pending.json().error.kind).toBe('authorization-pending');

    expect((await approve(cookie, { userCode, name: 'my laptop' })).status).toBe(204);
    const done = await poll(deviceCode);
    expect(done.status).toBe(200);
    const body = done.json();
    expect(body.accessToken).toMatch(/^sbs_[A-Za-z0-9_-]{43}$/);
    expect(body.tokenType).toBe('Bearer');
    expect(body.scopes).toEqual(['read', 'write']);
    expect(done.headers['cache-control']).toBe('no-store');
  });

  it('accepts the user code however it is typed: lower case, no dash, spaces', async () => {
    const cookie = await signIn(ALICE);
    for (const spell of [(c: string) => c.toLowerCase(), (c: string) => c.replace('-', ''), (c: string) => c.replace('-', ' ')]) {
      const { userCode } = await startDevice();
      expect((await approve(cookie, { userCode: spell(userCode) })).status).toBe(204);
    }
  });

  it('shows the token once: the same device code cannot collect a second one', async () => {
    const cookie = await signIn(ALICE);
    const { deviceCode } = await mint(cookie);
    const again = await poll(deviceCode);
    expect(again.status).toBe(400);
    expect(again.json().error.kind).toBe('expired-code');
  });

  it('lets a user code approve only once', async () => {
    const cookie = await signIn(ALICE);
    const { userCode } = await startDevice();
    expect((await approve(cookie, { userCode })).status).toBe(204);
    const second = await approve(cookie, { userCode });
    expect(second.status).toBe(404);
    expect(second.json().error.kind).toBe('unknown-code');
  });

  it('refuses a code that is not shaped like one, a code nobody started, and scopes that do not exist', async () => {
    const cookie = await signIn(ALICE);
    expect((await approve(cookie, { userCode: 'nope' })).json().error.kind).toBe('invalid-code');
    expect((await approve(cookie, {})).status).toBe(422);
    expect((await approve(cookie, { userCode: 'BCDF-GHJK' })).json().error.kind).toBe('unknown-code');
    const { userCode } = await startDevice();
    const badScopes = await approve(cookie, { userCode, scopes: ['read', 'root'] });
    expect(badScopes.status).toBe(422);
    expect(badScopes.json().error.kind).toBe('invalid-scopes');
    expect(badScopes.json().error.message).toContain('read, write');
    expect((await approve(cookie, { userCode, scopes: [] })).status).toBe(422);
  });

  it('lets a code expire: after ten minutes it can neither be approved nor collected', async () => {
    const cookie = await signIn(ALICE);
    const { deviceCode, userCode } = await startDevice();
    clock += 9 * 60 * 1000 + 59_000;
    expect((await poll(deviceCode)).json().error.kind).toBe('authorization-pending');
    clock += 1_000;
    expect((await poll(deviceCode)).json().error.kind).toBe('expired-code');
    expect((await approve(cookie, { userCode })).status).toBe(404);
  });

  it('does not let an approved but uncollected code outlive its ten minutes', async () => {
    const cookie = await signIn(ALICE);
    const { deviceCode, userCode } = await startDevice();
    expect((await approve(cookie, { userCode })).status).toBe(204);
    clock += 10 * 60 * 1000;
    expect((await poll(deviceCode)).json().error.kind).toBe('expired-code');
  });

  it('tells a CLI that polls too fast to slow down, and lets it back in after the interval', async () => {
    const { deviceCode } = await startDevice();
    expect((await poll(deviceCode)).json().error.kind).toBe('authorization-pending');
    clock += 2_000;
    expect((await poll(deviceCode)).json().error.kind).toBe('slow-down');
    clock += 4_000;
    expect((await poll(deviceCode)).json().error.kind).toBe('authorization-pending');
  });

  it('refuses a poll that names no device code, or one nobody issued', async () => {
    expect((await raw('/v1/auth/device/token', { method: 'POST', body: '{}' })).json().error.kind).toBe('invalid-code');
    expect((await poll('made-up')).json().error.kind).toBe('expired-code');
  });

  it('needs a signed-in browser to approve, and a bearer token is not one', async () => {
    const cookie = await signIn(ALICE);
    const { token } = await mint(cookie);
    const { userCode } = await startDevice();
    expect((await raw('/v1/auth/device/approve', { method: 'POST', body: JSON.stringify({ userCode }) })).status).toBe(401);
    const withToken = await raw('/v1/auth/device/approve', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify({ userCode }),
    });
    expect(withToken.status).toBe(401);
  });

  it('keeps the ADR-0029 guards on the browser-facing steps: a foreign Origin cannot approve', async () => {
    const cookie = await signIn(ALICE);
    const { userCode } = await startDevice();
    const reply = await raw('/v1/auth/device/approve', {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ userCode }),
    });
    expect(reply.status).toBe(403);
    // And the code is still waiting, so the refusal did not spend it.
    expect((await approve(cookie, { userCode })).status).toBe(204);
  });
});

describe('a bearer token', () => {
  it('acts as the user who approved it: it sees their charts and writes into their library', async () => {
    const cookie = await signIn(ALICE);
    expect((await jsonPost('/v1/scores', create('soul'), cookie)).status).toBe(201);
    const { token } = await mint(cookie);

    expect((await raw('/v1/scores', { headers: bearer(token) })).json().scores.map((s: { id: string }) => s.id)).toEqual(['soul']);
    const made = await raw('/v1/scores', {
      method: 'POST',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify(create('standards')),
    });
    expect(made.status).toBe(201);
    // Seen from the browser session of the same person: one library, two ways in.
    const ids = (await raw('/v1/scores', { headers: { cookie } })).json().scores.map((s: { id: string }) => s.id);
    expect(ids.sort()).toEqual(['soul', 'standards']);
    const me = await raw('/v1/me', { headers: bearer(token) });
    expect(me.json().user.login).toBe('alice');
  });

  it('cannot reach another user\'s data: Bob\'s token sees none of Alice\'s charts', async () => {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    expect((await jsonPost('/v1/scores', create('secret'), alice)).status).toBe(201);
    const { token } = await mint(bob);
    expect((await raw('/v1/scores/secret', { headers: bearer(token) })).status).toBe(404);
    expect((await raw('/v1/scores', { headers: bearer(token) })).json()).toEqual({ scores: [] });
    expect((await raw('/v1/scores/secret/export?format=pdf', { headers: bearer(token) })).status).toBe(404);
  });

  it('is refused when it is garbage, not ours, or the wrong scheme — and a cookie does not rescue it', async () => {
    const cookie = await signIn(ALICE);
    const { token } = await mint(cookie);
    for (const header of ['Bearer sbs_madeupmadeupmadeupmadeupmadeupmadeupmadeup1', 'Bearer not-ours', 'Bearer ', 'Basic Zm9vOmJhcg==', token]) {
      const shown = header === token ? '(bare token)' : header;
      // Alone, and with a perfectly good session cookie beside it: what was presented is what is judged.
      for (const extra of [{}, { cookie }]) {
        const reply = await raw('/v1/scores', { headers: { authorization: header, ...extra } });
        expect({ header: shown, withCookie: 'cookie' in extra, status: reply.status }).toEqual({
          header: shown,
          withCookie: 'cookie' in extra,
          status: 401,
        });
      }
    }
    // A valid cookie alongside a bad token: the token is what was presented, so it is what is judged.
    expect((await raw('/v1/scores', { headers: { cookie, authorization: 'Bearer sbs_nope' } })).status).toBe(401);
  });

  it('expires after ninety days, with no purge needed', async () => {
    const cookie = await signIn(ALICE);
    const { token } = await mint(cookie);
    clock += 89 * 24 * 60 * 60 * 1000;
    expect((await raw('/v1/scores', { headers: bearer(token) })).status).toBe(200);
    clock += 2 * 24 * 60 * 60 * 1000;
    expect((await raw('/v1/scores', { headers: bearer(token) })).status).toBe(401);
  });

  it('is limited to its scopes: read-only reads and cannot write, write-only writes and cannot read', async () => {
    const cookie = await signIn(ALICE);
    const reader = await mint(cookie, { scopes: ['read'] });
    const writer = await mint(cookie, { scopes: ['write'] });

    expect((await raw('/v1/scores', { headers: bearer(reader.token) })).status).toBe(200);
    const refusedWrite = await raw('/v1/scores', {
      method: 'POST',
      headers: { ...bearer(reader.token), 'content-type': 'application/json' },
      body: JSON.stringify(create('x')),
    });
    expect(refusedWrite.status).toBe(403);
    expect(refusedWrite.json().error.kind).toBe('insufficient-scope');
    expect((await raw('/v1/scores/x', { headers: bearer(reader.token) })).status).toBe(404); // nothing was created

    expect(
      (await raw('/v1/scores', { method: 'POST', headers: { ...bearer(writer.token), 'content-type': 'application/json' }, body: JSON.stringify(create('y')) })).status,
    ).toBe(201);
    const refusedRead = await raw('/v1/scores', { headers: bearer(writer.token) });
    expect(refusedRead.status).toBe(403);
    expect(refusedRead.json().error.kind).toBe('insufficient-scope');
  });

  it('is not a way to see or change tokens: listing and revoking are for a signed-in browser only', async () => {
    const cookie = await signIn(ALICE);
    const { token, tokenId } = await mint(cookie);
    expect((await raw('/v1/auth/tokens', { headers: bearer(token) })).status).toBe(401);
    expect((await raw(`/v1/auth/tokens/${tokenId}`, { method: 'DELETE', headers: bearer(token) })).status).toBe(401);
    expect((await raw('/v1/scores', { headers: bearer(token) })).status).toBe(200);
  });
});

describe('listing and revoking tokens', () => {
  it('lists a user\'s own tokens with what a person needs to recognise them, and never the token', async () => {
    const cookie = await signIn(ALICE);
    const first = await mint(cookie, { name: 'laptop', scopes: ['read'] });
    await mint(cookie, { name: 'ci' });
    await mint(await signIn(BOB), { name: 'bobs' });

    const reply = await raw('/v1/auth/tokens', { headers: { cookie } });
    expect(reply.status).toBe(200);
    const tokens = reply.json().tokens;
    expect(tokens.map((t: { name: string }) => t.name)).toEqual(['ci', 'laptop']);
    expect(tokens[1]).toEqual({
      id: first.tokenId,
      name: 'laptop',
      scopes: ['read'],
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    expect(reply.body).not.toContain(first.token);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect((await raw('/v1/auth/tokens')).status).toBe(401);
  });

  it('revokes a token at once: the next request with it is a 401', async () => {
    const cookie = await signIn(ALICE);
    const { token, tokenId } = await mint(cookie);
    expect((await raw('/v1/scores', { headers: bearer(token) })).status).toBe(200);
    expect((await raw(`/v1/auth/tokens/${tokenId}`, { method: 'DELETE', headers: { cookie } })).status).toBe(204);
    expect((await raw('/v1/scores', { headers: bearer(token) })).status).toBe(401);
    expect((await raw('/v1/auth/tokens', { headers: { cookie } })).json().tokens).toEqual([]);
    expect((await raw(`/v1/auth/tokens/${tokenId}`, { method: 'DELETE', headers: { cookie } })).status).toBe(404);
  });

  it('will not revoke somebody else\'s token, and says nothing that tells it from one that does not exist', async () => {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    const { token, tokenId } = await mint(alice);
    const theirs = await raw(`/v1/auth/tokens/${tokenId}`, { method: 'DELETE', headers: { cookie: bob } });
    const missing = await raw('/v1/auth/tokens/tok_nonexistent', { method: 'DELETE', headers: { cookie: bob } });
    expect(theirs.status).toBe(404);
    expect(theirs.json().error.kind).toBe(missing.json().error.kind);
    expect((await raw('/v1/scores', { headers: bearer(token) })).status).toBe(200);
  });

  it('refuses a foreign Origin on a revoke, even with a valid session', async () => {
    const cookie = await signIn(ALICE);
    const { tokenId } = await mint(cookie);
    const reply = await raw(`/v1/auth/tokens/${tokenId}`, { method: 'DELETE', headers: { cookie, origin: 'https://evil.example' } });
    expect(reply.status).toBe(403);
  });
});

describe('credentials never leak', () => {
  it('puts no device code, user code or token in a log line, or in any response but the one that is theirs', async () => {
    const cookie = await signIn(ALICE);
    const { token, deviceCode, userCode } = await mint(cookie);
    // Provoke the refusal paths too, which are where a careless message would echo what it was given.
    await raw('/v1/scores', { headers: { authorization: 'Bearer sbs_madeup' } });
    await poll(deviceCode);
    await approve(cookie, { userCode });
    const text = logged.join('\n');
    for (const secret of [token, deviceCode, userCode, userCode.replace('-', ''), 'sbs_madeup']) {
      expect(text).not.toContain(secret);
    }
    const listing = await raw('/v1/auth/tokens', { headers: { cookie } });
    expect(listing.body).not.toContain(token);
    const refused = await raw('/v1/scores', { headers: { authorization: `Bearer ${token}x` } });
    expect(refused.body).not.toContain(token);
  });
});

describe('local mode has no device flow', () => {
  it('does not route any of it, rather than routing it and failing', async () => {
    const localStore = openSqliteStore({ filename: ':memory:' });
    const local = createApi({ store: localStore, logger: recordingLogger() });
    const { port: localPort } = await local.listen(0);
    try {
      for (const [method, path] of [
        ['POST', '/v1/auth/device'],
        ['POST', '/v1/auth/device/token'],
        ['POST', '/v1/auth/device/approve'],
        ['GET', '/v1/auth/tokens'],
      ] as const) {
        const reply = await fetch(`http://127.0.0.1:${localPort}${path}`, { method });
        expect({ path, status: reply.status }).toEqual({ path, status: 404 });
      }
      // And an Authorization header is not an alternative principal there: it is simply ignored.
      expect((await fetch(`http://127.0.0.1:${localPort}/v1/scores`, { headers: { authorization: 'Bearer sbs_x' } })).status).toBe(200);
    } finally {
      await local.close();
      await localStore.close();
    }
  });
});

// --- helpers that need the app's own vocabulary -----------------------------------------------------

function now(): string {
  return new Date(clock).toISOString().slice(0, 19) + 'Z';
}

/** The hash the store keys a cookie header's session by. */
async function hashOf(cookieHeader: string): Promise<string> {
  return createHash('sha256').update(cookieHeader.replace('sb_session=', '')).digest('hex');
}

/** Open a stream, read until the first frame (or the end of a refusal), and drop the connection. */
function firstFrame(path: string, cookie: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { cookie, accept: 'text/event-stream' } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
          if (text.includes('\n\n')) {
            resolve({ status: res.statusCode ?? 0, text });
            res.destroy();
          }
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('error', (error) => {
      // Destroying the response after resolving surfaces as an error; only an early one is a failure.
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
    });
    req.end();
  });
}
