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
  clientName: string;
  /** Where the browser goes next, as a host a person can check against the client they started. */
  destination: string;
  /** What the client will be able to do, in the words the page shows. */
  grants: string[];
}

/** The request as the page describes it, or `null` if the parameters could not be an authorisation request. */
export function describeRequest(params: Record<string, string>): ConsentView | null {
  const { client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge } = params;
  if (!clientId || !redirectUri || !challenge) return null;
  let destination: string;
  try {
    const url = new URL(redirectUri);
    // A private-use scheme has no host worth showing; the scheme is the destination.
    destination = url.host === '' ? url.protocol : url.host;
  } catch {
    return null;
  }
  const scopes = (params.scope ?? '').split(/\s+/).filter((scope) => scope !== '');
  const grants = (scopes.length === 0 ? Object.keys(SCOPE_WORDS) : scopes).map((scope) => SCOPE_WORDS[scope] ?? scope);
  const name = (params.client_name ?? '').trim();
  return { clientName: name === '' ? 'An MCP client' : name, destination, grants };
}

/** What to tell a person whose consent the server refused. */
export function consentFailure(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return 'Your session ended. Sign in again, then start over from the client.';
  }
  if (error instanceof ApiError) return 'That request is not valid any more. Start again from the client.';
  return 'Could not reach the server. Try again in a moment.';
}
