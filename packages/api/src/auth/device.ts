import { randomInt, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { problem } from '../http/problems.js';
import { MALFORMED, readJsonBody, send, sendJson } from '../http/routes.js';
import { TOKEN_SCOPES } from '../store/auth.js';
import type { AuthStore, TokenScope, UserId } from '../store/auth.js';
import { timestamp } from '../store/store-shared.js';
import { hashToken, randomToken } from './secrets.js';

/**
 * Device authorisation and API tokens (V21a, ADR-0034 decision 4): how `sbscore` and an agent get a
 * credential of their own without ever being handed a password, a session cookie or one of GitHub's tokens.
 *
 * ### The flow (RFC 8628 in shape, our own server end to end)
 *
 *   `POST /v1/auth/device`           the CLI asks to be authorised. Answers a **device code** (a secret only
 *                                    the CLI holds), a short **user code** a person types, and where to type it.
 *   `POST /v1/auth/device/approve`   a person signed in **by cookie** names the user code and approves it.
 *   `POST /v1/auth/device/token`     the CLI polls with its device code. Pending, slow down, expired, or the
 *                                    token — once.
 *
 * GitHub is not in this flow at all. The approver is already signed in (V20), so the CLI receives a token
 * *we* minted, and no GitHub credential can reach it (ADR-0034 decision 4).
 *
 * **Approval takes a cookie and never a token.** A token must not be able to mint tokens, or a leaked
 * read-only one becomes a permanent foothold with whatever scopes it names; and the approval is the one
 * step where a human says yes, which a bearer credential cannot be. Token management (`list`, `revoke`)
 * is cookie-only for the same reason.
 *
 * ### What is stored
 *
 * Only hashes (`store/auth.ts`): the SHA-256 of the device code and of the token. The plaintext token
 * exists once, in the response to the poll that collects it, and the response is `no-store`. Nothing in
 * this file logs a code, a token or a body — there is no log outlet here at all.
 */

/** The token's recognisable prefix. A leaked one is findable by a secret scanner, and obviously ours. */
export const TOKEN_PREFIX = 'sbs_';

/**
 * No vowels, no 0/O/1/I/L: a code read aloud or off a terminal cannot be mistaken for another, and cannot
 * spell a word. 28 symbols over 8 characters is about 3.7 x 10^11, against a 10-minute life and a poll
 * that needs a signed-in human to complete.
 */
const USER_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXYZ23456789';
const USER_CODE_LENGTH = 8;

export const DEVICE_TTL_MS = 10 * 60 * 1000;
export const POLL_INTERVAL_SECONDS = 5;
export const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_NAME_LENGTH = 60;
const DEFAULT_NAME = 'sbscore CLI';

export interface DeviceRoutesOptions {
  auth: AuthStore;
  /** Where a person goes to approve, e.g. `https://sibei.example/#/device`. The browser page is V21b's. */
  verificationUri: string;
  now: () => Date;
  /** The user behind this request's session **cookie**, or `null`. A bearer token is deliberately not an answer. */
  sessionUser(request: IncomingMessage): Promise<UserId | null>;
}

export interface DeviceRoutes {
  /** Handle one of the device-flow or token-management paths, or return `null` if the path is not theirs. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<number | null>;
}

/** `ABCD-EFGH` for the eye. Input is normalised by {@link normaliseUserCode}, so either spelling works. */
function newUserCode(): string {
  let code = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return code;
}

export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** What a person types, as stored: upper case, no dash or spaces. `null` if it could not be one of ours. */
export function normaliseUserCode(typed: unknown): string | null {
  if (typeof typed !== 'string') return null;
  const code = typed.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== USER_CODE_LENGTH) return null;
  for (const ch of code) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export function createDeviceRoutes(options: DeviceRoutesOptions): DeviceRoutes {
  const { auth, now } = options;

  const unauthenticated = (response: ServerResponse): number =>
    send(response, problem(401, 'unauthenticated', 'not a principal this server knows'));

  async function start(response: ServerResponse): Promise<number> {
    const deviceCode = randomToken();
    const userCode = newUserCode();
    const at = now();
    await auth.createDevice({
      deviceHash: hashToken(deviceCode),
      userCode,
      expiresAt: timestamp(() => new Date(at.getTime() + DEVICE_TTL_MS)),
    });
    // Housekeeping on the path that already writes; correctness never depends on it.
    await auth.purgeExpiredCredentials(timestamp(now)).catch(() => 0);
    response.setHeader('cache-control', 'no-store');
    return sendJson(response, 200, {
      deviceCode,
      userCode: formatUserCode(userCode),
      verificationUri: options.verificationUri,
      expiresIn: DEVICE_TTL_MS / 1000,
      interval: POLL_INTERVAL_SECONDS,
    });
  }

  async function approve(request: IncomingMessage, response: ServerResponse): Promise<number> {
    const userId = await options.sessionUser(request);
    if (userId === null) return unauthenticated(response);

    const body = await readJsonBody(request, response);
    if (body === MALFORMED) return 400;
    const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};

    const userCode = normaliseUserCode(fields.userCode);
    if (userCode === null) {
      return send(
        response,
        problem(422, 'invalid-code', 'that is not a device code: it is eight letters and digits, like ABCD-EFGH'),
      );
    }
    const scopes = parseScopes(fields.scopes);
    if (scopes === null) {
      return send(
        response,
        problem(422, 'invalid-scopes', `scopes must be a non-empty list of: ${TOKEN_SCOPES.join(', ')}`),
      );
    }
    const name = parseName(fields.name);

    const approved = await auth.approveDevice(userCode, { userId, name, scopes }, timestamp(now));
    // One answer for a code that never existed, one that expired and one already used: telling them apart
    // would let anyone probe which codes are live.
    if (!approved) {
      return send(response, problem(404, 'unknown-code', 'that code is not waiting for approval; it may have expired'));
    }
    response.setHeader('cache-control', 'no-store');
    response.writeHead(204).end();
    return 204;
  }

  async function poll(request: IncomingMessage, response: ServerResponse): Promise<number> {
    const body = await readJsonBody(request, response);
    if (body === MALFORMED) return 400;
    const deviceCode = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).deviceCode : undefined;
    if (typeof deviceCode !== 'string' || deviceCode === '') {
      return send(response, problem(422, 'invalid-code', 'the poll needs the deviceCode from the authorisation request'));
    }

    const result = await auth.pollDevice(hashToken(deviceCode), timestamp(now), POLL_INTERVAL_SECONDS * 1000);
    response.setHeader('cache-control', 'no-store');
    if (result.status === 'pending') {
      return send(response, problem(400, 'authorization-pending', 'waiting for the code to be approved in the browser'));
    }
    if (result.status === 'slow-down') {
      return send(response, problem(400, 'slow-down', `poll no more often than every ${POLL_INTERVAL_SECONDS} seconds`));
    }
    if (result.status === 'expired') {
      return send(response, problem(400, 'expired-code', 'that code expired or was already used; start again'));
    }

    // Authorised, and already spent by the poll that returned it. Mint the token this code was for.
    const token = TOKEN_PREFIX + randomToken();
    const at = now();
    const expiresAt = timestamp(() => new Date(at.getTime() + TOKEN_TTL_MS));
    const made = await auth.createToken({
      id: `tok_${randomUUID()}`,
      tokenHash: hashToken(token),
      userId: result.userId,
      name: result.name,
      scopes: result.scopes,
      expiresAt,
    });
    return sendJson(response, 200, {
      accessToken: token,
      tokenType: 'Bearer',
      tokenId: made.id,
      scopes: made.scopes,
      expiresAt: made.expiresAt,
    });
  }

  async function list(request: IncomingMessage, response: ServerResponse): Promise<number> {
    const userId = await options.sessionUser(request);
    if (userId === null) return unauthenticated(response);
    response.setHeader('cache-control', 'no-store');
    return sendJson(response, 200, { tokens: await auth.listTokens(userId) });
  }

  async function revoke(request: IncomingMessage, response: ServerResponse, id: string): Promise<number> {
    const userId = await options.sessionUser(request);
    if (userId === null) return unauthenticated(response);
    // Another user's token and a token that never existed are the same 404.
    if (!(await auth.revokeToken(userId, id))) {
      return send(response, problem(404, 'no-such-token', `you have no token ${JSON.stringify(id)}`));
    }
    response.writeHead(204).end();
    return 204;
  }

  function methodNotAllowed(response: ServerResponse, allowed: string): number {
    response.setHeader('allow', allowed);
    return send(response, problem(405, 'method-not-allowed', `try ${allowed}`));
  }

  return {
    async handle(request, response) {
      const method = (request.method ?? 'GET').toUpperCase();
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;

      if (path === '/v1/auth/device') return method === 'POST' ? start(response) : methodNotAllowed(response, 'POST');
      if (path === '/v1/auth/device/token') return method === 'POST' ? poll(request, response) : methodNotAllowed(response, 'POST');
      if (path === '/v1/auth/device/approve') return method === 'POST' ? approve(request, response) : methodNotAllowed(response, 'POST');
      if (path === '/v1/auth/tokens') return method === 'GET' ? list(request, response) : methodNotAllowed(response, 'GET');
      const one = /^\/v1\/auth\/tokens\/([^/]+)$/.exec(path);
      if (one !== null) {
        if (method !== 'DELETE') return methodNotAllowed(response, 'DELETE');
        let id: string;
        try {
          id = decodeURIComponent(one[1]!);
        } catch {
          return send(response, problem(404, 'no-such-token', 'no such token'));
        }
        return revoke(request, response, id);
      }
      return null;
    },
  };
}

function parseScopes(value: unknown): TokenScope[] | null {
  if (value === undefined) return [...TOKEN_SCOPES];
  if (!Array.isArray(value) || value.length === 0) return null;
  const scopes: TokenScope[] = [];
  for (const scope of value) {
    if (typeof scope !== 'string' || !(TOKEN_SCOPES as readonly string[]).includes(scope)) return null;
    if (!scopes.includes(scope as TokenScope)) scopes.push(scope as TokenScope);
  }
  return scopes;
}

function parseName(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_NAME;
  const name = value.trim().slice(0, MAX_NAME_LENGTH);
  return name === '' ? DEFAULT_NAME : name;
}
