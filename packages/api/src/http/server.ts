import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createApplier } from '../ops/applier.js';
import type { Applier } from '../ops/applier.js';
import type { ScoreStore } from '../store/repository.js';
import { LOOPBACK, checkHost, checkOrigin, resolveLocalPrincipal } from './guards.js';
import type { Authenticator } from './guards.js';
import { problem, problemForUnknown } from './problems.js';
import { pathOf, route, send } from './routes.js';
import { consoleLogger } from './log.js';
import type { Logger } from './log.js';

/**
 * The server, and the composition root.
 *
 * The `/v1/` API is **the highest-value seam in the project** (PLAN.md), because both surfaces go
 * through it and it is where "the UI and the CLI cannot disagree" is either true or false. The CLI
 * is an HTTP client of exactly this (ADR-0002), so there is no second write path to keep in step.
 *
 * Plain `node:http` rather than a framework. Five routes and one JSON body parser is not a
 * framework's worth of work, and ADR-0029's guards are worth *writing* rather than configuring — a
 * misconfigured CORS default is precisely the failure this API cannot afford. Express was the
 * alternative and stays a small change if the route surface ever grows teeth.
 *
 * This file is the only one that holds the whole store. It immediately narrows it into the halves
 * the routes get, which is how ADR-0003's single write path survives the arrival of an HTTP layer.
 */

export interface ApiOptions {
  store: ScoreStore;
  /** Defaults to one built over the store. Injected so a test can watch what the applier is told. */
  applier?: Applier;
  /** Defaults to resolving `local` (ADR-0029). */
  authenticate?: Authenticator;
  logger?: Logger;
}

export interface Api {
  server: Server;
  /**
   * Bind and start. **`127.0.0.1` only, never `0.0.0.0`** (ADR-0029) — the host is deliberately not
   * a parameter, because the one thing that must never happen is somebody passing the wrong one,
   * and a compose file's default would otherwise expose the port on the host's network. Port 0 asks
   * the OS for a free one, which is what tests use.
   */
  listen(port: number): Promise<{ port: number }>;
  close(): Promise<void>;
}

export function createApi(options: ApiOptions): Api {
  const store = options.store;
  const applier = options.applier ?? createApplier(store);
  const authenticate = options.authenticate ?? resolveLocalPrincipal;
  const logger = options.logger ?? consoleLogger;

  const server = createHttpServer((request, response) => {
    const started = process.hrtime.bigint();
    void handle(request, response)
      .then((status) => {
        // Structured, and deliberately narrow: method, path, status, duration. No bodies and no
        // file paths (ADR-0029) — the store's filename is a host path and has no business in a log.
        logger.request({
          method: request.method ?? '?',
          path: pathOf(request),
          status,
          durationMs: round(Number(process.hrtime.bigint() - started) / 1e6),
        });
      })
      .catch((error: unknown) => {
        logger.error('the request handler itself failed', error);
        if (!response.headersSent) response.writeHead(500).end();
      });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<number> {
    // The guards run *before* routing, so an unrouted path cannot become a way past them.
    const host = checkHost(request);
    if (!host.ok) return send(response, problem(403, 'foreign-host', host.reason));

    const origin = checkOrigin(request);
    if (!origin.ok) return send(response, problem(403, 'foreign-origin', origin.reason));

    const principal = authenticate(request);
    if (principal === null) {
      return send(response, problem(401, 'unauthenticated', 'not a principal this server knows'));
    }

    try {
      // The narrowing. `store` satisfies both halves, but the routes are typed to see only these,
      // so no handler can reach a write path (ADR-0003).
      return await route(request, response, {
        reader: store,
        library: store,
        applier,
        owner: principal.owner,
      });
    } catch (error) {
      const outcome = problemForUnknown(error);
      if (outcome.status >= 500) logger.error('a request failed', error);
      if (response.headersSent) return outcome.status;
      return send(response, outcome);
    }
  }

  return {
    server,
    listen(port) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, LOOPBACK, () => {
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('the server did not bind to a port'));
            return;
          }
          resolve({ port: address.port });
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
