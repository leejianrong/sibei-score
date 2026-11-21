import type { IncomingMessage, ServerResponse } from 'node:http';
import { problem } from '../http/problems.js';
import type { Authenticator } from '../http/guards.js';
import { MALFORMED, readJsonBody, send, sendJson } from '../http/routes.js';
import type { Exporter } from '../export/export.js';
import type { Applier } from '../ops/applier.js';
import type { ScoreReader } from '../store/repository.js';
import { createServerBackend } from './backend.js';
import { MAX_MCP_BATCH, handleMcpMessage } from './protocol.js';
import { toolRateClass } from './tools.js';
import type { ToolAccess } from './tools.js';

/**
 * `POST /mcp` — the Streamable HTTP transport of the MCP endpoint (V22a, ADR-0034 decision 5), and the door
 * an OAuth 2.1 *resource* has to keep.
 *
 * **It takes a bearer token and nothing else.** A session cookie is not accepted here, whatever it says: the
 * endpoint is for agents, a cookie is ambient authority a browser attaches to requests the person never
 * made, and MCP's authorisation spec is bearer-only. The token must be of the `mcp:` scope family — the
 * audience this endpoint answers to — so a CLI token (`read`/`write`) is refused here as an MCP token is by
 * `/v1/`, and what a token may do is its `mcp:read` / `mcp:write` scopes, checked per tool.
 *
 * A caller with no usable token gets a `401` carrying `WWW-Authenticate: Bearer resource_metadata=…`, which
 * is how an MCP client that has never heard of this server finds the protected-resource metadata and, from
 * it, the authorisation server (`auth/oauth.ts`).
 *
 * The transport is stateless: one POST, one JSON answer (or `202` for a notification). `GET` and `DELETE`
 * answer `405`, which the spec allows for a server with no server-initiated messages and no sessions.
 */

export interface McpEndpointOptions {
  reader: ScoreReader;
  applier: Applier;
  exporter: Exporter;
  /** Resolves a request to its token's principal, or `null`. The hosted authenticator. */
  authenticate: Authenticator;
  /** Where the protected-resource metadata is served, for the `WWW-Authenticate` challenge. */
  resourceMetadataUrl: string;
  /**
   * Charge one request of a rate-limit class to a user (SEC H2). Returns the status it answered with when
   * refused (it has already sent the 429), `null` when admitted. Absent means unlimited: a local install.
   */
  charge?: (response: ServerResponse, owner: string, cls: 'read' | 'write' | 'export') => Promise<number | null>;
  onError?: (message: string, error: unknown) => void;
}

export interface McpEndpoint {
  handle(request: IncomingMessage, response: ServerResponse): Promise<number>;
}

export function createMcpEndpoint(options: McpEndpointOptions): McpEndpoint {
  const challenge = (error?: string, description?: string): string =>
    `Bearer resource_metadata="${options.resourceMetadataUrl}"` +
    (error === undefined ? '' : `, error="${error}"${description === undefined ? '' : `, error_description="${description}"`}`);

  function refuse(response: ServerResponse, status: number, kind: string, message: string, header: string): number {
    response.setHeader('www-authenticate', header);
    return send(response, problem(status, kind, message));
  }

  return {
    async handle(request, response) {
      const method = (request.method ?? 'GET').toUpperCase();
      if (method !== 'POST') {
        response.setHeader('allow', 'POST');
        return send(response, problem(405, 'method-not-allowed', 'this endpoint takes POST (no server-initiated stream, no sessions)'));
      }

      // A bearer token only. No `Authorization` header is the discovery case: say where to find out more.
      if (request.headers.authorization === undefined) {
        return refuse(response, 401, 'unauthenticated', 'send a bearer token; see the WWW-Authenticate header for how to get one', challenge());
      }
      const principal = await options.authenticate(request);
      if (principal === null || principal.scopes === undefined) {
        return refuse(response, 401, 'unauthenticated', 'not a token this server knows', challenge('invalid_token', 'unknown, expired or revoked token'));
      }
      const scopes = principal.scopes;
      if (!scopes.some((scope) => scope === 'mcp:read' || scope === 'mcp:write')) {
        // A `/v1/` token: valid, but issued for another audience.
        return refuse(response, 401, 'wrong-audience', 'this token was not issued for the MCP endpoint', challenge('invalid_token', 'token audience is not this resource'));
      }

      const body = await readJsonBody(request, response);
      if (body === MALFORMED) return 400;

      // `/mcp` returns ahead of the generic per-user gate, so it spends the same budgets itself: each
      // `tools/call` is charged to its class, anything else as a read. Charged per message, so a batch
      // cannot buy more than separate requests would.
      if (options.charge !== undefined) {
        const messages = Array.isArray(body) ? (body.length > MAX_MCP_BATCH ? [] : body) : [body];
        for (const message of messages) {
          const call = typeof message === 'object' && message !== null ? (message as { method?: unknown; params?: { name?: unknown } }) : {};
          const cls = call.method === 'tools/call' ? toolRateClass(call.params?.name) : 'read';
          const refused = await options.charge(response, principal.owner, cls);
          if (refused !== null) return refused;
        }
      }

      const backend = createServerBackend({
        owner: principal.owner,
        reader: options.reader,
        applier: options.applier,
        exporter: options.exporter,
        onError: (error) => options.onError?.('an MCP tool failed', error),
      });
      const answer = await handleMcpMessage(body, {
        backend,
        can: (access: ToolAccess) => scopes.includes(`mcp:${access}`),
        onUnexpected: (error) => options.onError?.('an MCP tool failed unexpectedly', error),
      });
      if (answer === null) {
        response.writeHead(202).end();
        return 202;
      }
      response.setHeader('cache-control', 'no-store');
      return sendJson(response, 200, answer);
    },
  };
}
