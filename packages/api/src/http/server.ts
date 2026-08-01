import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { BlobStore } from '../blob/blob-store.js';
import { memoryBlobStore } from '../blob/memory-blob-store.js';
import { createChangeBus, publishingApplier, publishingLibrary } from '../events/change-bus.js';
import { createExporter } from '../export/export.js';
import { createApplier } from '../ops/applier.js';
import type { Applier } from '../ops/applier.js';
import type { ScoreStore } from '../store/repository.js';
import { createEventStreams } from './event-stream.js';
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
  /**
   * Where cached exports live (ADR-0006). Defaults to a process-lifetime `Map`, which is the
   * honest default: a cache that outlives the process needs a directory, and a directory is the
   * caller's to name — this package takes a port, never a path (ADR-0001).
   */
  blobs?: BlobStore;
  /** Defaults to resolving `local` (ADR-0029). */
  authenticate?: Authenticator;
  logger?: Logger;
  /**
   * How often an idle event stream writes its keep-alive comment. Defaults to
   * `DEFAULT_HEARTBEAT_MS`; injected because a test cannot wait fifteen seconds to watch one.
   */
  heartbeatMs?: number;
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
  const authenticate = options.authenticate ?? resolveLocalPrincipal;
  const logger = options.logger ?? consoleLogger;

  // The change bus (V4a). This file is the only one holding both halves of it, exactly as it is the
  // only one holding both halves of the store — the mutating paths get the publisher by being
  // wrapped in it, the routes get the subscriber, and neither can reach the other's capability.
  const bus = createChangeBus({
    onError: (error) => logger.error('an event subscriber failed', error),
  });

  // Wrapped rather than plumbed in, so `applier.ts` stays the only consumer of a `ScoreWriter`
  // (ADR-0003) and an injected test applier announces its writes like the real one does.
  const applier = publishingApplier(options.applier ?? createApplier(store), bus);
  // Deleting a score is not an operation and never goes near the applier, but it is every bit as
  // much an external change to a browser holding that chart open.
  const library = publishingLibrary(store, bus);
  const events = createEventStreams({
    subscriber: bus,
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  });

  // Narrowed on the way in: the exporter is handed the store as a `ScoreReader`, so the export
  // path is a read by construction and not by intention (ADR-0003).
  const exporter = createExporter(store, options.blobs ?? memoryBlobStore());

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
        library,
        applier,
        exporter,
        events,
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
      // **Ending the streams first is load-bearing, not tidiness.** `server.close()` stops
      // accepting and then waits for open connections to finish, and an SSE stream never finishes —
      // so before V4a this line hung forever the moment anything had subscribed. Closing what this
      // server opened, rather than reaching for `closeAllConnections()`, leaves an ordinary
      // in-flight request to complete the way it always did.
      events.closeAll();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
