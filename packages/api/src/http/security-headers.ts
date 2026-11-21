import type { ServerResponse } from 'node:http';

/**
 * Browser-hardening headers on every response (SIB2-206, security review M3).
 *
 * The app is one Svelte bundle served by this API from the same origin, so the policy can be strict:
 * scripts only from ourselves, no plugins, no `<base>`, and (the point of the review finding) **no framing
 * by anyone** (`frame-ancestors 'none'`), so the approval, consent and account-delete pages cannot be put
 * inside another site and clicked through. `X-Frame-Options: DENY` covers browsers without CSP framing support.
 *
 * `style-src` keeps `'unsafe-inline'` because Svelte and the engraved score SVG use `style=` attributes; scripts
 * (the thing XSS needs) get none. `img-src` admits `data:`/`blob:` for scan thumbnails and inline SVG.
 *
 * Set with `setHeader` at the top of the request, so every later `writeHead` (static file, JSON, error, SSE)
 * carries them without each route knowing.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader('content-security-policy', CONTENT_SECURITY_POLICY);
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
}
