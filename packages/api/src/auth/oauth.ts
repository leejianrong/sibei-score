import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { problem } from '../http/problems.js';
import { MALFORMED, MAX_BODY_BYTES, queryOf, readJsonBody, send, sendJson } from '../http/routes.js';
import { MCP_SCOPES } from '../store/auth.js';
import type { AuthStore, TokenScope, UserId } from '../store/auth.js';
import { timestamp } from '../store/store-shared.js';
import { TOKEN_PREFIX } from './device.js';
import { hashToken, pkceChallenge, randomToken, sameSecret } from './secrets.js';

/**
 * The OAuth 2.1 authorisation server for the MCP endpoint (V22a, ADR-0034 decision 5).
 *
 * `/mcp` is an OAuth *resource*: an MCP client that has never heard of us discovers where to get a token,
 * registers itself, sends the person to a consent page and exchanges a code for a bearer token. This file
 * is that authorisation server, and it is deliberately the smallest one the MCP authorisation spec accepts:
 * authorisation-code grant only, PKCE `S256` mandatory, public clients only (`none` authentication), no
 * refresh tokens (the token lives 30 days, a third of a CLI token's life because the client behind it is
 * self-registered and unverified, and is revocable from the token page).
 *
 * ### What it reuses
 *
 * Consent reuses the GitHub **session**: the authorise endpoint sends the browser to the SPA's consent page
 * (`#/authorize`), which is behind the same sign-in gate as everything else, and approval is a
 * cookie-authenticated POST — **never a token**, for the reason `device.ts` gives. The token it mints is an
 * ordinary V21 `sbs_` token, stored hashed, listed and revocable on the token page, expiring in 30 days (`MCP_TOKEN_TTL_MS`).
 *
 * ### Audience
 *
 * RFC 8707 resource indicators say a token is for one resource. Here the audience is carried by the **scope
 * family** (`store/auth.ts`): this flow can only mint `mcp:read`/`mcp:write`, `/mcp` accepts only those,
 * and `/v1/` refuses them (and the CLI's `read`/`write` tokens are refused by `/mcp`). A `resource`
 * parameter, if a client sends one, must name `/mcp` exactly.
 *
 * ### Dynamic client registration is stateless
 *
 * A registered client is a `client_id` that *contains* its name and redirect URIs (`sbc_` + base64url of
 * JSON). There is no table because registration grants nothing: it only says where a code may be sent, and
 * the person approving sees that destination. Anyone could register anything under a stored scheme too, so
 * a signature would add no property worth the secret it needs. The redirect URI is the whole of the trust,
 * so it is validated at registration, at authorisation and again at approval and at the token exchange.
 */

export const MCP_PATH = '/mcp';
const OAUTH = '/v1/auth/oauth';
const CODE_TTL_MS = 5 * 60 * 1000;
/** Shorter than a CLI token (SIB2-207): anyone can register an MCP client under any name, so access lapses sooner. */
export const MCP_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * Redirect hosts the consent page treats as a known MCP client (SIB2-207). Everything else gets a visible
 * warning, because registration is open and the name is the client's own claim. `*.example.com` matches any
 * subdomain; an entry is a hostname, never a URL. Overridable with `SBSCORE_MCP_KNOWN_HOSTS` (comma-separated).
 */
export const DEFAULT_MCP_KNOWN_HOSTS: readonly string[] = ['claude.ai', '*.claude.ai', 'localhost', '127.0.0.1', '[::1]'];
const MAX_REDIRECTS = 5;
const MAX_CLIENT_ID = 4096;
const MAX_NAME = 60;
const DEFAULT_CLIENT_NAME = 'An MCP client';
const CLIENT_PREFIX = 'sbc_';
/** Schemes that execute or embed content: never a place to send a code. */
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:', 'ws:', 'wss:']);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface OAuthRoutesOptions {
  auth: AuthStore;
  /** The deployment's own origin, e.g. `https://sibei.example`. The issuer and the base of every endpoint. */
  origin: string;
  now: () => Date;
  /** The user behind this request's session **cookie**, or `null`. A bearer token is deliberately not an answer. */
  sessionUser(request: IncomingMessage): Promise<UserId | null>;
}

export interface OAuthRoutes {
  /** The resource URL a token must be minted for, and `/mcp` answers at. */
  resource: string;
  /** Answer a `/.well-known/…` metadata path, or `null` if it is not one of ours. */
  handleWellKnown(request: IncomingMessage, response: ServerResponse): number | null;
  /** Answer a `/v1/auth/oauth/…` path, or `null` if it is not one of ours. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<number | null>;
}

interface RegisteredClient {
  name: string;
  redirectUris: string[];
}

export function createOAuthRoutes(options: OAuthRoutesOptions): OAuthRoutes {
  const { auth, now, origin } = options;
  const resource = `${origin}${MCP_PATH}`;
  const scopesSupported = [...MCP_SCOPES];

  const resourceMetadata = {
    resource,
    authorization_servers: [origin],
    scopes_supported: scopesSupported,
    bearer_methods_supported: ['header'],
    resource_name: 'sibei-score',
  };
  const serverMetadata = {
    issuer: origin,
    authorization_endpoint: `${origin}${OAUTH}/authorize`,
    token_endpoint: `${origin}${OAUTH}/token`,
    registration_endpoint: `${origin}${OAUTH}/register`,
    scopes_supported: scopesSupported,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
  };

  function oauthError(response: ServerResponse, status: number, error: string, description: string): number {
    // RFC 6749 §5.2's own shape, not ours: an OAuth client branches on `error`, not on `kind`.
    response.setHeader('cache-control', 'no-store');
    return sendJson(response, status, { error, error_description: description });
  }

  function notAllowed(response: ServerResponse, allowed: string): number {
    response.setHeader('allow', allowed);
    return send(response, problem(405, 'method-not-allowed', `try ${allowed}`));
  }

  /** Why a redirect URI cannot be one, or `null` if it can. */
  function badRedirect(uri: unknown): string | null {
    if (typeof uri !== 'string' || uri === '' || uri.length > 2000) return 'a redirect URI must be a string of reasonable length';
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return `${JSON.stringify(uri)} is not an absolute URL`;
    }
    if (url.hash !== '') return 'a redirect URI must not carry a fragment';
    if (FORBIDDEN_SCHEMES.has(url.protocol)) return `a redirect URI cannot use ${url.protocol}`;
    if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
      return 'a redirect URI must be https, or http on a loopback address';
    }
    return null;
  }

  function encodeClient(client: RegisteredClient): string {
    return CLIENT_PREFIX + Buffer.from(JSON.stringify({ n: client.name, r: client.redirectUris }), 'utf8').toString('base64url');
  }

  function decodeClient(clientId: unknown): RegisteredClient | null {
    if (typeof clientId !== 'string' || !clientId.startsWith(CLIENT_PREFIX) || clientId.length > MAX_CLIENT_ID) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(clientId.slice(CLIENT_PREFIX.length), 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    const n = (parsed as { n?: unknown } | null)?.n;
    const r = (parsed as { r?: unknown } | null)?.r;
    if (typeof n !== 'string' || !Array.isArray(r) || r.length === 0 || r.length > MAX_REDIRECTS) return null;
    if (r.some((uri) => badRedirect(uri) !== null)) return null;
    return { name: n, redirectUris: r as string[] };
  }

  async function register(request: IncomingMessage, response: ServerResponse): Promise<number> {
    const body = await readJsonBody(request, response);
    if (body === MALFORMED) return 400;
    const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const uris = fields.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECTS) {
      return oauthError(response, 400, 'invalid_redirect_uri', `redirect_uris must list between 1 and ${MAX_REDIRECTS} URIs`);
    }
    for (const uri of uris) {
      const why = badRedirect(uri);
      if (why !== null) return oauthError(response, 400, 'invalid_redirect_uri', why);
    }
    const method = fields.token_endpoint_auth_method;
    if (method !== undefined && method !== 'none') {
      return oauthError(response, 400, 'invalid_client_metadata', 'only public clients are supported: token_endpoint_auth_method must be "none"');
    }
    const name =
      typeof fields.client_name === 'string' && fields.client_name.trim() !== ''
        ? fields.client_name.trim().slice(0, MAX_NAME)
        : DEFAULT_CLIENT_NAME;
    const redirectUris = [...new Set(uris as string[])];
    const clientId = encodeClient({ name, redirectUris });
    if (clientId.length > MAX_CLIENT_ID) {
      return oauthError(response, 400, 'invalid_redirect_uri', 'those redirect URIs are too long to register');
    }
    response.setHeader('cache-control', 'no-store');
    return sendJson(response, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(now().getTime() / 1000),
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    });
  }

  /** Scopes out of a space-separated `scope`, or `null` if one is not ours. Absent means all of ours. */
  function parseScope(raw: string | null | undefined): TokenScope[] | null {
    if (raw === null || raw === undefined || raw.trim() === '') return [...MCP_SCOPES];
    const scopes: TokenScope[] = [];
    for (const scope of raw.trim().split(/\s+/)) {
      if (!(MCP_SCOPES as readonly string[]).includes(scope)) return null;
      if (!scopes.includes(scope as TokenScope)) scopes.push(scope as TokenScope);
    }
    return scopes;
  }

  interface Request {
    client: RegisteredClient;
    clientId: string;
    redirectUri: string;
    challenge: string;
    state: string | null;
    scopes: TokenScope[];
  }

  type Checked = { ok: true; request: Request } | { ok: false; error: string; description: string; redirectable: boolean };

  /** The one validation of an authorisation request, run by `authorize` and again by `approve`. */
  function check(get: (key: string) => string | null | undefined): Checked {
    const clientId = get('client_id') ?? '';
    const client = decodeClient(clientId);
    // An unknown client or an unregistered redirect URI is never redirected to: that is the open redirector.
    if (client === null) return { ok: false, error: 'invalid_client', description: 'unknown client_id', redirectable: false };
    const redirectUri = get('redirect_uri') ?? '';
    if (!client.redirectUris.includes(redirectUri)) {
      return { ok: false, error: 'invalid_request', description: 'redirect_uri is not one this client registered', redirectable: false };
    }
    const fail = (error: string, description: string): Checked => ({ ok: false, error, description, redirectable: true });
    if (get('response_type') !== 'code') return fail('unsupported_response_type', 'only response_type=code is supported');
    const challenge = get('code_challenge') ?? '';
    if (get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
      return fail('invalid_request', 'PKCE is required: send an S256 code_challenge');
    }
    const asked = get('resource');
    if (asked !== null && asked !== undefined && asked !== '' && asked !== resource) {
      return fail('invalid_target', `this server issues tokens only for ${resource}`);
    }
    const scopes = parseScope(get('scope'));
    if (scopes === null) return fail('invalid_scope', `scope must be a subset of: ${scopesSupported.join(' ')}`);
    return { ok: true, request: { client, clientId, redirectUri, challenge, state: get('state') ?? null, scopes } };
  }

  function redirectBack(redirectUri: string, state: string | null, params: Record<string, string>): string {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (state !== null) url.searchParams.set('state', state);
    url.searchParams.set('iss', origin);
    return url.toString();
  }

  /**
   * `GET …/authorize`: validate, then hand the browser to the consent page. Nothing is recorded: the
   * consent page re-sends the same parameters on approval, which is validated again, so this endpoint is
   * stateless and a stale or forged link gets nothing past the second check.
   */
  function authorize(request: IncomingMessage, response: ServerResponse): number {
    const query = queryOf(request);
    const checked = check((key) => query.get(key));
    if (!checked.ok) {
      if (!checked.redirectable) return send(response, problem(400, checked.error, checked.description));
      const target = redirectBack(query.get('redirect_uri')!, query.get('state'), {
        error: checked.error,
        error_description: checked.description,
      });
      response.writeHead(302, { location: target, 'cache-control': 'no-store' });
      response.end();
      return 302;
    }
    const page = new URLSearchParams({
      client_id: checked.request.clientId,
      redirect_uri: checked.request.redirectUri,
      code_challenge: checked.request.challenge,
      scope: checked.request.scopes.join(' '),
      // For the page to say who is asking. Display only: approval re-reads the client from `client_id`.
      client_name: checked.request.client.name,
    });
    if (checked.request.state !== null) page.set('state', checked.request.state);
    response.writeHead(302, { location: `/#/authorize?${page.toString()}`, 'cache-control': 'no-store' });
    response.end();
    return 302;
  }

  /** `POST …/approve`: a person signed in by **cookie** says yes (or no). Answers where to send the browser. */
  async function approve(request: IncomingMessage, response: ServerResponse): Promise<number> {
    const userId = await options.sessionUser(request);
    if (userId === null) return send(response, problem(401, 'unauthenticated', 'not a principal this server knows'));
    const body = await readJsonBody(request, response);
    if (body === MALFORMED) return 400;
    const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const text = (key: string): string | null => (typeof fields[key] === 'string' ? (fields[key] as string) : null);
    // The consent page sends back the parameters it was handed, under the same names; the two that the
    // authorise step already fixed (`response_type`, the PKCE method) are not the page's to vary.
    const checked = check((key) => (key === 'response_type' ? 'code' : key === 'code_challenge_method' ? 'S256' : text(key)));
    response.setHeader('cache-control', 'no-store');
    if (!checked.ok) return send(response, problem(400, checked.error, checked.description));
    const { request: asked } = checked;

    if (fields.approve !== true) {
      return sendJson(response, 200, {
        redirectTo: redirectBack(asked.redirectUri, asked.state, { error: 'access_denied', error_description: 'the person declined' }),
      });
    }
    const code = randomToken();
    const at = now();
    await auth.createAuthCode({
      codeHash: hashToken(code),
      clientId: asked.clientId,
      userId,
      redirectUri: asked.redirectUri,
      codeChallenge: asked.challenge,
      scopes: asked.scopes,
      name: `${asked.client.name} (MCP)`.slice(0, MAX_NAME + 6),
      expiresAt: timestamp(() => new Date(at.getTime() + CODE_TTL_MS)),
    });
    await auth.purgeExpiredCredentials(timestamp(now)).catch(() => 0);
    return sendJson(response, 200, { redirectTo: redirectBack(asked.redirectUri, asked.state, { code }) });
  }

  /** `POST …/token`: the authorisation-code exchange, answered with an ordinary V21 token. */
  async function token(request: IncomingMessage, response: ServerResponse): Promise<number> {
    const form = await readForm(request, response);
    if (form === null) return 400;
    const get = (key: string): string => form.get(key) ?? '';

    if (get('grant_type') !== 'authorization_code') {
      return oauthError(response, 400, 'unsupported_grant_type', 'only authorization_code is supported');
    }
    const verifier = get('code_verifier');
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || get('code') === '') {
      return oauthError(response, 400, 'invalid_request', 'code and a code_verifier (43 to 128 characters) are required');
    }
    const asked = get('resource');
    if (asked !== '' && asked !== resource) {
      return oauthError(response, 400, 'invalid_target', `this server issues tokens only for ${resource}`);
    }

    // Spent before anything is compared, so a failed attempt cannot be retried with a better guess.
    const grant = await auth.consumeAuthCode(hashToken(get('code')), timestamp(now));
    const refused = (): number => oauthError(response, 400, 'invalid_grant', 'that code is invalid, expired, or already used');
    if (grant === null) return refused();
    if (grant.clientId !== get('client_id') || grant.redirectUri !== get('redirect_uri')) return refused();
    if (!sameSecret(pkceChallenge(verifier), grant.codeChallenge)) return refused();

    const accessToken = TOKEN_PREFIX + randomToken();
    const at = now();
    const made = await auth.createToken({
      id: `tok_${randomUUID()}`,
      tokenHash: hashToken(accessToken),
      userId: grant.userId,
      name: grant.name,
      scopes: grant.scopes,
      expiresAt: timestamp(() => new Date(at.getTime() + MCP_TOKEN_TTL_MS)),
    });
    response.setHeader('cache-control', 'no-store');
    response.setHeader('pragma', 'no-cache');
    return sendJson(response, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(MCP_TOKEN_TTL_MS / 1000),
      scope: made.scopes.join(' '),
    });
  }

  return {
    resource,
    handleWellKnown(request, response) {
      const method = (request.method ?? 'GET').toUpperCase();
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const metadata =
        path === '/.well-known/oauth-protected-resource' || path === `/.well-known/oauth-protected-resource${MCP_PATH}`
          ? resourceMetadata
          : path === '/.well-known/oauth-authorization-server'
            ? serverMetadata
            : null;
      if (metadata === null) return null;
      if (method !== 'GET') return notAllowed(response, 'GET');
      response.setHeader('cache-control', 'public, max-age=3600');
      return sendJson(response, 200, metadata);
    },
    async handle(request, response) {
      const method = (request.method ?? 'GET').toUpperCase();
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (path === `${OAUTH}/register`) return method === 'POST' ? register(request, response) : notAllowed(response, 'POST');
      if (path === `${OAUTH}/authorize`) return method === 'GET' ? authorize(request, response) : notAllowed(response, 'GET');
      if (path === `${OAUTH}/approve`) return method === 'POST' ? approve(request, response) : notAllowed(response, 'POST');
      if (path === `${OAUTH}/token`) return method === 'POST' ? token(request, response) : notAllowed(response, 'POST');
      return null;
    },
  };
}

/** A token request's body: form-encoded as the spec says, or JSON from a lenient client. `null` once answered. */
async function readForm(request: IncomingMessage, response: ServerResponse): Promise<URLSearchParams | null> {
  const type = (request.headers['content-type'] ?? '').toLowerCase();
  if (type.startsWith('application/json')) {
    const body = await readJsonBody(request, response);
    if (body === MALFORMED) return null;
    const form = new URLSearchParams();
    if (typeof body === 'object' && body !== null) {
      for (const [key, value] of Object.entries(body)) if (typeof value === 'string') form.set(key, value);
    }
    return form;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      response.setHeader('connection', 'close');
      send(response, problem(413, 'body-too-large', `a request body is capped at ${MAX_BODY_BYTES} bytes`));
      request.destroy();
      return null;
    }
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
