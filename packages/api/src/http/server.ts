import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { BlobStore } from '../blob/blob-store.js';
import { memoryBlobStore } from '../blob/memory-blob-store.js';
import { createChangeBus, publishingApplier, publishingLibrary } from '../events/change-bus.js';
import { createJobBus } from '../events/job-bus.js';
import { createExporter } from '../export/export.js';
import { createJobRunner } from '../imports/runner.js';
import type { JobRunner } from '../imports/runner.js';
import type { WorkerClient } from '../imports/worker-client.js';
import { createApplier } from '../ops/applier.js';
import type { Applier } from '../ops/applier.js';
import { memoryJobStore } from '../store/memory-job-store.js';
import type { JobStore } from '../store/jobs.js';
import type { Owner, ScoreStore } from '../store/repository.js';
import { createEventStreams } from './event-stream.js';
import { createJobStreams } from './job-stream.js';
import { LOOPBACK, checkHost, checkOrigin, resolveLocalPrincipal } from './guards.js';
import type { Authenticator } from './guards.js';
import { problem, problemForUnknown } from './problems.js';
import { pathOf, route, send } from './routes.js';
import type { ImportService } from './routes.js';
import type { AssetSource } from './static.js';
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
  /**
   * The durable import-job queue (V10, ADR-0001). Defaults to a process-lifetime in-memory store —
   * the honest default, since a queue that outlives the process needs a database and a database is
   * the caller's to name (`sbscore serve` supplies the SQLite one). All import state lives here, so
   * the API process stays stateless (ADR-0001 #7).
   */
  jobs?: JobStore;
  /**
   * The OMR worker (ADR-0005). When omitted, the import feature is *off* — `POST /v1/imports` is a
   * 503 and no runner runs — and every other feature is unaffected (the milestone split, Q76, made
   * that more than theoretical). When supplied, imports are accepted and run; if the worker's
   * container is then down, a job fails with a diagnostic and is retryable (Q80). A port, never a
   * URL: the CLI composition root builds the HTTP client and injects it, so this package names no
   * address (ADR-0001).
   */
  worker?: WorkerClient;
  /** Defaults to resolving `local` (ADR-0029). */
  authenticate?: Authenticator;
  logger?: Logger;
  /**
   * How often an idle event stream writes its keep-alive comment. Defaults to
   * `DEFAULT_HEARTBEAT_MS`; injected because a test cannot wait fifteen seconds to watch one.
   */
  heartbeatMs?: number;
  /**
   * The built browser UI, served from this same origin (V8g). Omitted in development — Vite serves
   * the app and proxies `/v1/` here — and supplied by `sbscore serve --ui` for a shipped container,
   * which is what makes the browser same-origin with the API the way ADR-0029's guards assume. A
   * port, never a path: the bytes are read by the caller (`packages/cli`), since ADR-0006 keeps the
   * filesystem out of this package. When absent, non-`/v1/` paths 404 as they always did.
   */
  assets?: AssetSource;
}

export interface Api {
  server: Server;
  /**
   * Bind and start. **Defaults to `127.0.0.1`**, and every caller that omits `host` still binds
   * loopback exactly as before (ADR-0029). `host` is a parameter only because a container has to
   * (ADR-0029 amendment, V8h): Docker forwards a published port to the container's *bridge*
   * interface, so a loopback-only process is unreachable from the host, and the LAN-unreachability
   * ADR-0029 wants moves to the *publish* address (`127.0.0.1:PORT:PORT` in the compose file), which
   * is where a container can actually enforce it. Binding `0.0.0.0` is the container's job to ask
   * for, deliberately — never a default here. Port 0 asks the OS for a free one, which tests use.
   */
  listen(port: number, host?: string): Promise<{ port: number }>;
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

  // One blob store, shared: the exporter caches rendered artefacts in it (Q81), and the import
  // pipeline stores uploaded scans in it and reads them back to hand to the worker. Hoisted so both
  // reach the same bytes rather than each falling back to its own `Map`.
  const blobs = options.blobs ?? memoryBlobStore();

  // Narrowed on the way in: the exporter is handed the store as a `ScoreReader`, so the export
  // path is a read by construction and not by intention (ADR-0003).
  const exporter = createExporter(store, blobs);

  // The import pipeline (V10). Its own change bus and streams, the sibling of the score ones — a job
  // moving is announced the same way a score moving is (ADR-0001's "subscribe"). The job store and
  // streams exist whether or not a worker was configured, so imports can always be *inspected*; the
  // runner, and therefore the ability to *submit*, exists only when a worker was.
  const jobs = options.jobs ?? memoryJobStore();
  const jobBus = createJobBus({ onError: (error) => logger.error('a job subscriber failed', error) });
  const jobStreams = createJobStreams({
    subscriber: jobBus,
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  });
  const runner: JobRunner | undefined =
    options.worker === undefined
      ? undefined
      : createJobRunner({
          jobs,
          blobs,
          worker: options.worker,
          publisher: jobBus,
          onError: (message, error) => logger.error(message, error),
        });
  const imports: ImportService = {
    available: runner !== undefined,
    async submit(owner: Owner, image: Buffer) {
      // Content-addressed: identical rescans dedupe, and the key names the exact bytes it stands for
      // (the same principle as the export cache's document digest, Q81). The BlobStore hashes the key
      // to a filename anyway, so any stable string does — this one is also provenance.
      const key = `import-source:${createHash('sha256').update(image).digest('hex')}`;
      await blobs.put(key, image);
      const job = jobs.create(owner, [key]);
      runner?.wake();
      return job;
    },
    retry(owner: Owner, id) {
      const job = jobs.retry(owner, id);
      if (job !== null) runner?.wake();
      return job;
    },
    reader: jobs,
    streams: jobStreams,
  };

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
        imports,
        owner: principal.owner,
        ...(options.assets === undefined ? {} : { assets: options.assets }),
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
    listen(port, host = LOOPBACK) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error('the server did not bind to a port'));
            return;
          }
          // Serving is the point at which processing durable jobs is correct: `start` recovers any
          // job left running by a previous process and drains whatever is queued (ADR-0001 #7).
          // Constructing the API does not touch the queue; binding a port does.
          runner?.start();
          resolve({ port: address.port });
        });
      });
    },
    close() {
      // **Ending the streams first is load-bearing, not tidiness.** `server.close()` stops
      // accepting and then waits for open connections to finish, and an SSE stream never finishes —
      // so before V4a this line hung forever the moment anything had subscribed. Closing what this
      // server opened, rather than reaching for `closeAllConnections()`, leaves an ordinary
      // in-flight request to complete the way it always did. The job streams are the second kind of
      // stream that never finishes (V10), so they close here too.
      runner?.stop();
      events.closeAll();
      jobStreams.closeAll();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
