import { ApiError } from './api.js';

/**
 * The browser's side of consenting to an MCP client (V22a): what the page says about the request it was
 * handed. Plain TypeScript so it is tested without a browser.
 *
 * **The server owns the request.** The authorise endpoint validated it before sending the browser here and
 * approval validates it again, so nothing here decides whether a request is acceptable — it only decides
 * how to describe it, and whether there is enough to show a person at all. A page opened by hand with the
 * parameters missing says so rather than offering a button the server would refuse.
 */

export const SCOPE_WORDS: Record<string, string> = {
  'mcp:read': 'Read your charts',
  'mcp:write': 'Create and change your charts',
};

export interface ConsentView {
  /** What the client *says* it is. Anyone can register any name, so the page never leads with it (SIB2-207). */
  clientName: string;
  /** Where the browser goes next, as a host a person can check against the client they started. */
  destination: string;
  /** The destination's origin (`https://claude.ai`), or its scheme for a private-use one: the page's headline. */
  origin: string;
  /** Whether the destination's host is on the server's list of known clients. False until the list is known. */
  known: boolean;
  /** What the client will be able to do, in the words the page shows. */
  grants: string[];
}

/** The request as the page describes it, or `null` if the parameters could not be an authorisation request. */
export function describeRequest(params: Record<string, string>, knownHosts: readonly string[] = []): ConsentView | null {
  const { client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge } = params;
  if (!clientId || !redirectUri || !challenge) return null;
  let destination: string;
  let origin: string;
  let known: boolean;
  try {
    const url = new URL(redirectUri);
    // A private-use scheme has no host worth showing; the scheme is the destination.
    destination = url.host === '' ? url.protocol : url.host;
    origin = url.host === '' ? url.protocol : url.origin;
    known = url.host !== '' && isKnownHost(url.hostname, knownHosts);
  } catch {
    return null;
  }
  const scopes = (params.scope ?? '').split(/\s+/).filter((scope) => scope !== '');
  const grants = (scopes.length === 0 ? Object.keys(SCOPE_WORDS) : scopes).map((scope) => SCOPE_WORDS[scope] ?? scope);
  const name = (params.client_name ?? '').trim();
  return { clientName: name === '' ? 'An MCP client' : name, destination, origin, known, grants };
}

/**
 * Whether a redirect hostname is on the server's list. An entry is a hostname; `*.example.com` matches any
 * subdomain of it (not `example.com` itself, which would be its own entry). Case does not matter.
 */
export function isKnownHost(hostname: string, knownHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return knownHosts.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('*.') ? host.endsWith(e.slice(1)) && host.length > e.length - 1 : host === e;
  });
}

/** What to tell a person whose consent the server refused. */
export function consentFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return 'Your session ended. Sign in again, then start over from the client.';
  }
  if (error instanceof ApiError) return 'That request is not valid any more. Start again from the client.';
  return 'Could not reach the server. Try again in a moment.';
}
