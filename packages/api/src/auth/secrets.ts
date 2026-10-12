import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The small, pure pieces of the sign-in flow: random tokens, hashing, PKCE and cookies (V20,
 * ADR-0034 decision 3). Nothing here touches a socket or a store, which is what lets the security
 * properties — a token is unguessable, a verifier matches its challenge, a comparison does not leak —
 * be asserted without a server.
 */

/** 256 bits of entropy, URL- and cookie-safe. The size of a session token, a `state` and a PKCE verifier. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The hex SHA-256 of a session token — the only form of it that is ever stored. A fast hash is right
 * here and a slow one (bcrypt, argon2) would be wrong: the input is 256 random bits, not a human's
 * password, so there is nothing to brute-force and a slow hash would only tax every request.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** RFC 7636 §4.2, method `S256`: the challenge a client sends is the base64url SHA-256 of its verifier. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Compare two secrets without an early exit, so a mismatch does not say how many leading bytes agreed. */
export function sameSecret(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

/** One cookie out of a `Cookie` header, or `undefined`. A value that is not a plain token is ignored. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() !== name) continue;
    const value = part.slice(at + 1).trim();
    return /^[A-Za-z0-9_.-]+$/.test(value) ? value : undefined;
  }
  return undefined;
}

export interface CookieOptions {
  path: string;
  /** Seconds. `0` expires it now, which is how a cookie is cleared. */
  maxAge: number;
  secure: boolean;
}

/**
 * A `Set-Cookie` value. Always `HttpOnly` (script cannot read a session) and `SameSite=Lax`. Lax rather
 * than Strict because the OAuth callback is a top-level cross-site *navigation* from GitHub, which Strict
 * would strip the cookie from; Lax still withholds it from cross-site POSTs, subresource loads and
 * `fetch`, which is the CSRF surface. `Secure` whenever the deployment is https, which is always in
 * production (`hosted.ts` refuses a plain-http public URL that is not loopback).
 */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  return (
    `${name}=${value}; Path=${options.path}; Max-Age=${options.maxAge}; HttpOnly; SameSite=Lax` +
    (options.secure ? '; Secure' : '')
  );
}
