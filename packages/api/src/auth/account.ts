import type { IncomingMessage, ServerResponse } from 'node:http';
import { problem } from '../http/problems.js';
import { MALFORMED, readJsonBody, send } from '../http/routes.js';
import type { AuthStore, UserId } from '../store/auth.js';

/**
 * Account deletion (V25, ADR-0034 decision 11): `DELETE /v1/auth/account`.
 *
 * **A session cookie, never a token.** A leaked CLI token must not be able to destroy the account it was
 * minted for, which is the same reason approval and token management are cookie-only (`device.ts`). It is
 * also why there is no `sbscore account delete` verb: the one capability Q79 does not give a CLI twin,
 * on purpose.
 *
 * **The login is typed back.** The body must be `{ "confirm": "<your login>" }`, so a stray request cannot
 * delete anything and the browser can make a person read what they are about to do. There is no soft
 * delete and no grace period (decision 11): when this answers 204 the content is gone, then the identity
 * rows, the session, and the cookie.
 *
 * The content is erased first (`eraseData`) and the identity last, so a failure leaves the person signed
 * in and able to try again.
 */
export interface AccountRoutesOptions {
  auth: AuthStore;
  /** The user behind this request's session cookie, or `null`. A bearer token is deliberately not an answer. */
  sessionUser(request: IncomingMessage): Promise<UserId | null>;
  /** Erase everything the user owns except the identity itself (`account/erase.ts`). */
  eraseData(owner: UserId): Promise<unknown>;
  /** The `Set-Cookie` header value that clears the session cookie. */
  clearSessionCookie(): string;
}

export interface AccountRoutes {
  handle(request: IncomingMessage, response: ServerResponse): Promise<number | null>;
}

export function createAccountRoutes(options: AccountRoutesOptions): AccountRoutes {
  return {
    async handle(request, response) {
      if ((request.url ?? '').split('?')[0] !== '/v1/auth/account') return null;
      const method = (request.method ?? 'GET').toUpperCase();
      if (method !== 'DELETE') {
        response.setHeader('allow', 'DELETE');
        return send(response, problem(405, 'method-not-allowed', 'try DELETE'));
      }

      const userId = await options.sessionUser(request);
      const user = userId === null ? null : await options.auth.getUser(userId);
      if (userId === null || user === null) {
        return send(response, problem(401, 'unauthenticated', 'not a principal this server knows'));
      }

      const body = await readJsonBody(request, response);
      if (body === MALFORMED) return 400;
      const confirm = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).confirm : undefined;
      if (typeof confirm !== 'string' || confirm.trim().toLowerCase() !== user.login.toLowerCase()) {
        return send(
          response,
          problem(422, 'confirmation-mismatch', 'to delete the account, send { "confirm": "<your login>" }'),
        );
      }

      await options.eraseData(userId);
      await options.auth.deleteUser(userId);
      response.setHeader('set-cookie', options.clearSessionCookie());
      response.setHeader('cache-control', 'no-store');
      response.writeHead(204).end();
      return 204;
    },
  };
}
