import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Authenticator } from '../http/guards.js';
import { problem } from '../http/problems.js';
import type { Problem } from '../http/problems.js';
import { pathOf, queryOf, send, sendJson } from '../http/routes.js';
import type { AuthStore, ProviderProfile } from '../store/auth.js';
import { timestamp } from '../store/store-shared.js';
import { hashToken, pkceChallenge, randomToken, readCookie, sameSecret, serializeCookie } from './secrets.js';

/**
 * Hosted-mode identity: the GitHub OAuth code flow, the cookie session, and the `Authenticator` built on
 * them (V20, ADR-0034 decision 3).
 *
 * **Selected by configuration, never by default.** Without a `HostedAuthOptions` the API resolves every
 * request to the local principal exactly as it did before V20 (`resolveLocalPrincipal`, owner `local`), so
 * a local install is unchanged. With one, every request must carry a live session, and the principal's
 * owner is the *user id* — which is what every store query already filters on, so tenancy needs no new
 * code at the rows, only a new answer to "who is asking".
 *
 * ### The flow
 *
 *   `GET  /v1/auth/github/login`     redirect to GitHub with a fresh `state` and a PKCE challenge
 *   `GET  /v1/auth/github/callback`  verify `state`, exchange the code with the verifier, read the profile,
 *                                    start a session, redirect to `/`
 *   `POST /v1/auth/logout`           end the session and clear the cookie
 *
 * **`state` and PKCE do different jobs and both are here.** `state` ties the callback to *this browser's*
 * login attempt, which is what stops a login-CSRF (an attacker completing the flow with their own account
 * and handing the victim the callback). PKCE ties the code to whoever began the exchange, which is what
 * makes an intercepted code useless. Both live in one short-lived `HttpOnly` cookie scoped to the auth
 * path, so the server holds no per-login state and a second API replica needs nothing shared (ADR-0034
 * decision 9).
 *
 * **GitHub's own token is used once and dropped.** It reads the profile and is then forgotten — never
 * stored, never logged, never sent to the browser or the CLI (ADR-0034 decision 4). So are the client
 * secret, the code and the session token: nothing in this file puts one in a log line or an error
 * message, and an upstream failure is reported in our words rather than by echoing what GitHub said.
 *
 * ### What stays public
 *
 * `/v1/health` and the built UI's static files answer without a session (a load balancer must reach the
 * first, and a signed-out browser must be able to load the shell to sign in from it), and so do the auth
 * routes themselves. Nothing else does — `server.ts` decides, and a path it does not name is private.
 */

export const GITHUB = 'github';
export const SESSION_COOKIE = 'sb_session';
const LOGIN_COOKIE = 'sb_oauth';
const AUTH_PATH = '/v1/auth/github';

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Long enough to type a password and a 2FA code at GitHub, short enough that an abandoned attempt dies. */
const LOGIN_TTL_SECONDS = 600;
const UPSTREAM_TIMEOUT_MS = 10_000;

export interface GitHubOptions {
  clientId: string;
  /** The OAuth App's secret. Held in memory for the token exchange and nowhere else. */
  clientSecret: string;
  /** Overridable so a test can point the flow at a fake GitHub. Defaults are GitHub's own. */
  authorizeUrl?: string;
  tokenUrl?: string;
  userUrl?: string;
}

export interface HostedAuthOptions {
  auth: AuthStore;
  /**
   * The address browsers reach this deployment at, e.g. `https://sibei.example`. Its origin is the OAuth
   * redirect URI's base and the one host the guards admit besides loopback. Must be `https` unless it is a
   * loopback address — a session cookie over plain http to a real host is a credential on the wire.
   */
  publicUrl: string;
  github: GitHubOptions;
  sessionTtlMs?: number;
  now?: () => Date;
  /** Where an upstream failure is reported — the message only, never a body, a code or a token. */
  onError?: (message: string, error: unknown) => void;
}

export interface HostedAuth {
  /** Hostnames the Host and Origin guards must admit for this deployment. */
  hosts: ReadonlySet<string>;
  authenticate: Authenticator;
  /** Handle a `/v1/auth/…` request. Needs no session — signing in is how one starts. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<number>;
  /**
   * Answer `GET /v1/me` for a principal the server has already authenticated (V20b). Lives here rather
   * than in a route because it reads a user, and no request path may hold an `AuthStore`.
   */
  me(response: ServerResponse, owner: string): Promise<number>;
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function createHostedAuth(options: HostedAuthOptions): HostedAuth {
  const publicUrl = new URL(options.publicUrl);
  const secure = publicUrl.protocol === 'https:';
  if (!secure && !(publicUrl.protocol === 'http:' && LOOPBACK_NAMES.has(publicUrl.hostname))) {
    throw new Error(
      `the public URL must be https (plain http is only accepted for a loopback address, which is for ` +
        `development): a session cookie sent over http to a real host can be read by anyone on the path.`,
    );
  }
  if (options.github.clientId === '' || options.github.clientSecret === '') {
    throw new Error('hosted mode needs a GitHub OAuth client id and secret');
  }

  const { auth } = options;
  const now = options.now ?? (() => new Date());
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const redirectUri = `${publicUrl.origin}${AUTH_PATH}/callback`;
  const authorizeUrl = options.github.authorizeUrl ?? 'https://github.com/login/oauth/authorize';
  const tokenUrl = options.github.tokenUrl ?? 'https://github.com/login/oauth/access_token';
  const userUrl = options.github.userUrl ?? 'https://api.github.com/user';
  const report = options.onError ?? (() => {});

  const authenticate: Authenticator = async (request) => {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (token === undefined) return null;
    // A missing, unknown and expired session are all the same answer to the caller: not signed in.
    const session = await auth.findSession(hashToken(token), timestamp(now));
    return session === null ? null : { owner: session.userId };
  };

  function redirect(response: ServerResponse, location: string, cookies: string[]): number {
    // No CORS header, as on every response (ADR-0029). `no-store` because this carries `Set-Cookie`.
    response.writeHead(302, { location, 'set-cookie': cookies, 'cache-control': 'no-store' });
    response.end();
    return 302;
  }

  const clearLogin = (): string => serializeCookie(LOGIN_COOKIE, '', { path: AUTH_PATH, maxAge: 0, secure });

  async function login(response: ServerResponse): Promise<number> {
    const state = randomToken();
    const verifier = randomToken();
    const target = new URL(authorizeUrl);
    target.searchParams.set('client_id', options.github.clientId);
    target.searchParams.set('redirect_uri', redirectUri);
    target.searchParams.set('state', state);
    target.searchParams.set('code_challenge', pkceChallenge(verifier));
    target.searchParams.set('code_challenge_method', 'S256');
    // Public profile only. The email is not wanted, and not asking is the privacy-respecting default.
    target.searchParams.set('scope', 'read:user');
    return redirect(response, target.toString(), [
      serializeCookie(LOGIN_COOKIE, `${state}.${verifier}`, {
        path: AUTH_PATH,
        maxAge: LOGIN_TTL_SECONDS,
        secure,
      }),
    ]);
  }

  async function callback(request: IncomingMessage, response: ServerResponse): Promise<number> {
    const query = queryOf(request);
    const pending = readCookie(request.headers.cookie, LOGIN_COOKIE);
    // The attempt is spent whatever happens next: a `state` is single-use, so the cookie goes on every
    // outcome below, including the refusals.
    response.setHeader('set-cookie', clearLogin());

    const [state, verifier] = pending?.split('.') ?? [];
    const given = query.get('state');
    if (state === undefined || verifier === undefined || given === null || !sameSecret(state, given)) {
      return send(
        response,
        problem(
          400,
          'invalid-state',
          'this sign-in attempt does not match one this browser started, so it was refused. Start again from the sign-in link.',
        ),
      );
    }
    if (query.get('error') !== null) {
      return send(response, problem(400, 'sign-in-denied', 'GitHub did not authorise the sign-in.'));
    }
    const code = query.get('code');
    if (code === null || code === '') {
      return send(response, problem(400, 'missing-code', 'the callback carried no authorisation code.'));
    }

    let profile: ProviderProfile;
    try {
      profile = await readProfile(code, verifier);
    } catch (error) {
      if (error instanceof CodeRejected) {
        return send(response, problem(400, 'sign-in-failed', 'GitHub did not accept that sign-in. Start again.'));
      }
      // Our words, not GitHub's: the message goes in a log, and an upstream body is not ours to repeat.
      report('the GitHub sign-in could not be completed', error instanceof Error ? new Error(error.message) : error);
      return send(
        response,
        problem(502, 'github-unavailable', 'GitHub could not be reached to complete the sign-in. Try again shortly.'),
      );
    }

    const user = await auth.signIn(profile);
    const token = randomToken();
    const at = now();
    await auth.createSession(hashToken(token), user.id, timestamp(() => new Date(at.getTime() + sessionTtlMs)));
    // Housekeeping on the path that already writes a session; correctness never depends on it.
    await auth.purgeExpiredSessions(timestamp(now)).catch(() => 0);

    return redirect(response, '/', [
      clearLogin(),
      serializeCookie(SESSION_COOKIE, token, { path: '/', maxAge: Math.floor(sessionTtlMs / 1000), secure }),
    ]);
  }

  /** Exchange the code, read the profile, and let the GitHub token go out of scope. */
  async function readProfile(code: string, verifier: string): Promise<ProviderProfile> {
    const exchanged = await fetch(tokenUrl, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: options.github.clientId,
        client_secret: options.github.clientSecret,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (exchanged.status >= 500) throw new Error(`the token endpoint answered ${exchanged.status}`);
    const body: unknown = await exchanged.json().catch(() => null);
    const accessToken = field(body, 'access_token');
    // GitHub answers a bad or reused code with 200 and `{ error: "bad_verification_code" }`.
    if (typeof accessToken !== 'string' || accessToken === '') throw new CodeRejected();

    const me = await fetch(userUrl, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'sibei-score',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!me.ok) throw new Error(`the user endpoint answered ${me.status}`);
    const profile: unknown = await me.json().catch(() => null);
    const id = field(profile, 'id');
    const login = field(profile, 'login');
    const name = field(profile, 'name');
    if ((typeof id !== 'number' && typeof id !== 'string') || typeof login !== 'string') {
      throw new Error('the user endpoint returned a profile without an id and a login');
    }
    // The numeric id is the subject: stable for the account's life, unlike the login, which can be renamed.
    return { provider: GITHUB, subject: String(id), login, name: typeof name === 'string' ? name : null };
  }

  async function logout(request: IncomingMessage, response: ServerResponse): Promise<number> {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (token !== undefined) await auth.deleteSession(hashToken(token));
    response.setHeader('set-cookie', serializeCookie(SESSION_COOKIE, '', { path: '/', maxAge: 0, secure }));
    response.setHeader('cache-control', 'no-store');
    response.writeHead(204).end();
    return 204;
  }

  async function me(response: ServerResponse, owner: string): Promise<number> {
    const user = await auth.getUser(owner);
    // A live session whose user is gone (an account deleted under it) is not signed in either.
    if (user === null) return send(response, problem(401, 'unauthenticated', 'not a principal this server knows'));
    // Only what the browser draws. Not the session, not the provider subject, not a timestamp it has no use for.
    response.setHeader('cache-control', 'no-store');
    return sendJson(response, 200, { mode: 'hosted', user: { id: user.id, login: user.login, name: user.name } });
  }

  return {
    hosts: new Set([publicUrl.hostname]),
    authenticate,
    me,
    async handle(request, response) {
      const method = (request.method ?? 'GET').toUpperCase();
      const path = pathOf(request);
      if (path === `${AUTH_PATH}/login`) {
        return method === 'GET' ? login(response) : notAllowed(response, 'GET');
      }
      if (path === `${AUTH_PATH}/callback`) {
        return method === 'GET' ? callback(request, response) : notAllowed(response, 'GET');
      }
      if (path === '/v1/auth/logout') {
        return method === 'POST' ? logout(request, response) : notAllowed(response, 'POST');
      }
      return send(response, notFound());
    },
  };
}

/** The code was refused by GitHub (bad, reused, or bound to a different verifier) — the user's to retry. */
class CodeRejected extends Error {}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function notAllowed(response: ServerResponse, allowed: string): number {
  response.setHeader('allow', allowed);
  return send(response, problem(405, 'method-not-allowed', `try ${allowed}`));
}

function notFound(): Problem {
  return problem(404, 'not-found', 'no such auth route');
}
