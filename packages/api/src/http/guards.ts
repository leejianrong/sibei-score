import type { IncomingMessage } from 'node:http';
import { LOCAL_OWNER } from '../store/repository.js';
import type { Owner } from '../store/repository.js';

/**
 * The boundary guards (ADR-0029).
 *
 * The threat model is worth restating because it is easy to over- or under-read. There are no
 * secrets here and no sensitive data — scores are the user's own music. The concern is the app
 * being **trivially drivable by something that is not the user**, and the realistic path to that
 * is a web page the user happens to visit while the server is running, not a hostile process on
 * their own machine. A local API token was considered and rejected: it adds setup friction to a
 * single-user tool and the checks below close the realistic path at no cost.
 *
 * ADR-0029 is explicit that these have to land **before** the browser UI exists, or they get
 * retrofitted against a working client and something gets loosened to make it pass. That is why
 * they are in this slice and not V4's.
 */

/** The loopback address, and never `0.0.0.0` — including in a compose file. */
export const LOOPBACK = '127.0.0.1';

/**
 * The principal a request acts as. Always `local` in the MVP; the seam exists so that filling it
 * in later is a change to one function rather than to every route (ADR-0001, Q48).
 */
export interface Principal {
  owner: Owner;
}

export type Authenticator = (request: IncomingMessage) => Principal | null;

/** Resolves every request to `local`. The whole of authentication in the MVP (Q46). */
export const resolveLocalPrincipal: Authenticator = () => ({ owner: LOCAL_OWNER });

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isStateChanging(method: string | undefined): boolean {
  return STATE_CHANGING.has((method ?? '').toUpperCase());
}

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Every hostname a loopback server may legitimately be addressed by. Anything else in `Host` means
 * the request arrived via a name that resolves *somewhere else* — which is what DNS rebinding
 * looks like from in here.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(header: string): string {
  // Strip the port. An IPv6 literal keeps its brackets, which is why they are in the set above.
  if (header.startsWith('[')) return header.slice(0, header.indexOf(']') + 1).toLowerCase();
  const colon = header.lastIndexOf(':');
  return (colon === -1 ? header : header.slice(0, colon)).toLowerCase();
}

/**
 * The `Host` header must name loopback.
 *
 * This goes one step past what ADR-0029 spells out, in the same direction. The ADR requires the
 * Origin check on *state-changing* requests, which closes drive-by writes — but a rebound **GET**
 * would still read the user's library out, and a browser sends no Origin on a simple cross-origin
 * GET. Checking Host closes that, costs nothing, and cannot inconvenience a real client, because a
 * real client is talking to localhost.
 */
export function checkHost(request: IncomingMessage): GuardVerdict {
  const host = request.headers.host;
  if (host === undefined || host === '') {
    return { ok: false, reason: 'a request must carry a Host header' };
  }
  const hostname = hostnameOf(host);
  if (!LOOPBACK_HOSTS.has(hostname)) {
    return {
      ok: false,
      reason:
        `this server answers only to localhost, and this request arrived addressed to ` +
        `${JSON.stringify(hostname)}. If you meant to reach it from another machine, that waits ` +
        `for the hosted version rather than being hacked around locally.`,
    };
  }
  return { ok: true };
}

/**
 * Validate `Origin` on state-changing requests and reject cross-origin ones. This is what closes
 * the DNS-rebinding and drive-by-request path, which plain localhost binding does not.
 *
 * **An absent Origin is allowed, and that is not a hole.** A browser always sends `Origin` on a
 * cross-origin request — including a form POST and a simple `fetch` — so absence means the caller
 * is not a browser page. The CLI and `curl` send none, and they are half the intended users
 * (ADR-0002). Requiring one would break the CLI while stopping nothing a browser can do.
 */
export function checkOrigin(request: IncomingMessage): GuardVerdict {
  if (!isStateChanging(request.method)) return { ok: true };

  const origin = request.headers.origin;
  if (origin === undefined || origin === '' || origin === 'null') return { ok: true };

  let hostname: string;
  try {
    const url = new URL(origin);
    hostname = url.hostname.toLowerCase();
  } catch {
    return { ok: false, reason: `${JSON.stringify(origin)} is not an origin` };
  }

  // Same-origin only, by hostname. The port is not pinned: the dev server and the built UI sit on
  // different ones and both are the user's own machine.
  if (!LOOPBACK_HOSTS.has(hostname) && !LOOPBACK_HOSTS.has(`[${hostname}]`)) {
    return {
      ok: false,
      reason:
        `a state-changing request from ${JSON.stringify(origin)} was rejected. This API answers ` +
        `only to its own origin, so that a web page you happen to be visiting cannot drive it.`,
    };
  }
  return { ok: true };
}
