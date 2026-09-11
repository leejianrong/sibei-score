import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Id } from '@sibei/model';
import {
  EXPORT_FONTS,
  EXPORT_FORMATS,
  EXPORT_INSTRUMENTS,
  EXPORT_PAPERS,
  parseExportFont,
  parseExportFormat,
  parseExportInstrument,
  parseExportPaper,
} from '../export/export.js';
import type { Artefact, Exporter } from '../export/export.js';
import { validateUpload } from '../imports/upload.js';
import type { UploadRejection } from '../imports/upload.js';
import type { Applier } from '../ops/applier.js';
import type { Batch, Operation } from '../ops/operations.js';
import type { ImportJob, JobId, JobReader } from '../store/jobs.js';
import type { Owner, ScoreLibrary, ScoreReader } from '../store/repository.js';
import type { EventStreams } from './event-stream.js';
import type { JobStreams } from './job-stream.js';
import { problem } from './problems.js';
import type { Problem } from './problems.js';
import { serveStaticAsset } from './static.js';
import type { AssetSource } from './static.js';

/**
 * The routes.
 *
 * **This file cannot write to a score.** It is handed a `ScoreReader` and a `ScoreLibrary` and
 * nothing else, so the only way a document changes from here is through the applier — which is
 * ADR-0003's single write path, made a fact of the wiring rather than a rule to remember. The
 * composition happens in `server.ts`; keeping it out of here is the point of the split.
 *
 * `/v1/` from the first commit (ADR-0022). Breaking changes are permitted inside v1 until the
 * hosted transition, at which point v1 freezes and becomes additive-only.
 */

export interface RouteContext {
  reader: ScoreReader;
  library: ScoreLibrary;
  applier: Applier;
  /** Reads a score and renders it. A read, and one that holds no writer (V3, Q81). */
  exporter: Exporter;
  /**
   * Subscribing to a score's changes, and nothing else. The narrowing again (V4a): `server.ts`
   * holds the whole change bus, and what arrives here can only *hear* a change — announcing one is
   * a capability that belongs beside making one, which is to say not in this file.
   */
  events: EventStreams;
  owner: Owner;
  /**
   * The OMR import pipeline (V10), or absent when this server was built without one. The routes get
   * a *service*, not the job store and the runner directly: submitting stores the upload and enqueues
   * a job, and it holds no `ScoreWriter` — the same narrowing every other capability here gets. A
   * failed import commits nothing (ADR-0003, Q80), so nothing this can do writes a score.
   */
  imports?: ImportService;
  /**
   * The built browser UI, served for any GET that no `/v1/` route claimed (V8g). Absent in
   * development, where Vite serves the app; present in a shipped container. A path outside `/v1/`
   * can only ever reach a file, never an API surface, because this is tried *after* every route.
   */
  assets?: AssetSource;
}

/**
 * The import capability handed to the routes. `available` is whether a worker was configured: the
 * job store, the listing and the streams exist regardless (you can always inspect past imports), but
 * *submitting* one needs a worker to run it, so `POST /v1/imports` is a 503 when there is none. When
 * a worker *is* configured but its container is down, a submit still succeeds and the job fails with
 * a diagnostic — that is the Q80 path, and it is the runner's to record, not this boundary's to
 * pre-empt.
 */
export interface ImportService {
  available: boolean;
  /** Store the (already validated) upload and enqueue a job for it, returning the queued job. */
  submit(owner: Owner, image: Buffer): Promise<ImportJob>;
  /** Requeue a failed job for a retry (Q80), or `null` if it is missing, not this owner's, or not failed. */
  retry(owner: Owner, id: JobId): ImportJob | null;
  /** Reads over the job store: list (summaries) and get (full, with the recognised objects). */
  reader: JobReader;
  /** The SSE progress streams. Subscribe-only from here, like the score event streams. */
  streams: JobStreams;
}

/** A body larger than this is refused unread. An op batch is kilobytes (ADR-0029: real caps). */
export const MAX_BODY_BYTES = 1_000_000;

const SCORES = '/v1/scores';
const IMPORTS = '/v1/imports';

/**
 * The cap on an uploaded image, at the transport. Larger than an op batch's 1 MB because an image is
 * the one thing that is legitimately big (ADR-0018: printed raster). `validateUpload` re-checks the
 * size as content — the two agree — but this one refuses the bytes *unread* so a hostile stream is
 * not buffered whole before being rejected, the same stance `readJsonBody` takes.
 */
const MAX_UPLOAD_BODY_BYTES = 25_000_000;

export async function route(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<number> {
  const method = (request.method ?? 'GET').toUpperCase();
  const path = pathOf(request);

  if (path === '/v1/health') {
    if (method !== 'GET') return methodNotAllowed(response, ['GET']);
    // "You cannot call it shipped if you cannot see it running." Nothing about the host in it —
    // no store path, no port, no versions of anything installed (ADR-0029).
    return sendJson(response, 200, { status: 'ok', api: 'v1' });
  }

  if (path === SCORES) {
    if (method === 'GET') return sendJson(response, 200, { scores: context.reader.list(context.owner) });
    if (method === 'POST') {
      const body = await readJsonBody(request, response);
      if (body === MALFORMED) return 400;
      // A create is a batch whose first operation is score.create, so it goes down the one write
      // path like everything else rather than beside it (ADR-0003).
      const result = context.applier.apply(context.owner, null, batchFrom(body));
      response.setHeader('location', `${SCORES}/${encodeURIComponent(result.scoreId)}`);
      return sendJson(response, 201, result);
    }
    return methodNotAllowed(response, ['GET', 'POST']);
  }

  const scoreId = match(path, /^\/v1\/scores\/([^/]+)$/);
  if (scoreId !== null) {
    if (method === 'GET') {
      const record = context.reader.get(context.owner, scoreId);
      if (record === null) return send(response, noSuchScore(scoreId));
      return sendJson(response, 200, {
        score: record.score,
        version: record.version,
        updatedAt: record.updatedAt,
      });
    }
    if (method === 'DELETE') {
      // Not an operation, and cannot be: it destroys the log an entry would live in (ADR-0003).
      if (!context.library.delete(context.owner, scoreId)) return send(response, noSuchScore(scoreId));
      response.writeHead(204).end();
      return 204;
    }
    return methodNotAllowed(response, ['GET', 'DELETE']);
  }

  const exportFor = match(path, /^\/v1\/scores\/([^/]+)\/export$/);
  if (exportFor !== null) {
    if (method !== 'GET') return methodNotAllowed(response, ['GET']);
    return await exportScore(request, response, context, exportFor);
  }

  const eventsFor = match(path, /^\/v1\/scores\/([^/]+)\/events$/);
  if (eventsFor !== null) {
    if (method !== 'GET') return methodNotAllowed(response, ['GET']);
    return openEventStream(request, response, context, eventsFor);
  }

  const opsFor = match(path, /^\/v1\/scores\/([^/]+)\/ops$/);
  if (opsFor !== null) {
    if (method !== 'POST') return methodNotAllowed(response, ['POST']);
    const body = await readJsonBody(request, response);
    if (body === MALFORMED) return 400;
    return sendJson(response, 200, context.applier.apply(context.owner, opsFor, batchFrom(body)));
  }

  // Undo and redo (V8a, ADR-0003). Their own routes rather than operations in an `/ops` batch,
  // because they are not content edits: they act on the *log*, and only the applier can read it.
  // Each carries `expectedVersion` like a write — the applier refuses one without it — so a client
  // cannot undo on top of an edit it never saw. The move is idempotent at the ends: undoing at the
  // first operation and redoing past the head come back 200 with `moved: false`, never an error.
  const undoFor = match(path, /^\/v1\/scores\/([^/]+)\/undo$/);
  if (undoFor !== null) {
    if (method !== 'POST') return methodNotAllowed(response, ['POST']);
    const body = await readJsonBody(request, response);
    if (body === MALFORMED) return 400;
    return sendJson(response, 200, context.applier.undo(context.owner, undoFor, expectedVersionFrom(body)));
  }

  const redoFor = match(path, /^\/v1\/scores\/([^/]+)\/redo$/);
  if (redoFor !== null) {
    if (method !== 'POST') return methodNotAllowed(response, ['POST']);
    const body = await readJsonBody(request, response);
    if (body === MALFORMED) return 400;
    return sendJson(response, 200, context.applier.redo(context.owner, redoFor, expectedVersionFrom(body)));
  }

  // Duplicate (V8c). A library-lifecycle call that *creates* a score, so it goes through the applier
  // (the only writer) rather than beside it — unlike delete, which destroys and cannot be an op. The
  // new id is minted from the source when the body names none; a 201 with a Location like a create.
  const duplicateFor = match(path, /^\/v1\/scores\/([^/]+)\/duplicate$/);
  if (duplicateFor !== null) {
    if (method !== 'POST') return methodNotAllowed(response, ['POST']);
    const body = await readJsonBody(request, response);
    if (body === MALFORMED) return 400;
    const result = context.applier.duplicate(context.owner, duplicateFor, newIdFrom(body));
    response.setHeader('location', `${SCORES}/${encodeURIComponent(result.scoreId)}`);
    return sendJson(response, 201, result);
  }

  // The OMR import pipeline (V10). Submit a scan and it becomes a job the client polls or subscribes
  // to (ADR-0001); the raw recognised objects land on the job, and mapping them to a score is V11.
  if (path === IMPORTS) {
    if (method === 'GET') {
      if (context.imports === undefined) return send(response, noImportPipeline());
      return sendJson(response, 200, { jobs: context.imports.reader.list(context.owner) });
    }
    if (method === 'POST') return await submitImport(request, response, context);
    return methodNotAllowed(response, ['GET', 'POST']);
  }

  const importEventsFor = match(path, /^\/v1\/imports\/([^/]+)\/events$/);
  if (importEventsFor !== null) {
    if (method !== 'GET') return methodNotAllowed(response, ['GET']);
    return openImportStream(request, response, context, importEventsFor);
  }

  const importRetryFor = match(path, /^\/v1\/imports\/([^/]+)\/retry$/);
  if (importRetryFor !== null) {
    if (method !== 'POST') return methodNotAllowed(response, ['POST']);
    return retryImport(response, context, importRetryFor);
  }

  const importFor = match(path, /^\/v1\/imports\/([^/]+)$/);
  if (importFor !== null) {
    if (method !== 'GET') return methodNotAllowed(response, ['GET']);
    if (context.imports === undefined) return send(response, noImportPipeline());
    const job = context.imports.reader.get(context.owner, importFor);
    if (job === null) return send(response, noSuchImport(importFor));
    return sendJson(response, 200, { job });
  }

  // The built UI, last (V8g). Only a GET, and only once every `/v1/` route above has declined, so a
  // file can never shadow the API — `serveStaticAsset` also returns null for a path the bundle has
  // no asset for, which falls through to the same 404 as before. `/v1/` is never served from here:
  // an unknown `/v1/` path is an API miss and must read as one, not as a missing file.
  if (method === 'GET' && context.assets && !path.startsWith('/v1/')) {
    const served = serveStaticAsset(response, context.assets, path);
    if (served !== null) return served;
  }

  return send(response, problem(404, 'no-such-route', `nothing at ${path}`));
}

/**
 * `GET /v1/scores/:id/events` — the change stream (V4a, SLICES.md V4 step 5).
 *
 * **Per score, not library-wide**, and that is the shape decision worth stating because `/v1/` goes
 * additive-only after the hosted transition (ADR-0022). Three reasons, in order of weight:
 *
 *  - It is what the demo needs: a browser with one chart open, repainting when `sibei note set`
 *    edits it. A library-wide stream would push every score's traffic at that client and leave it
 *    to filter — which is a per-score stream, paid for and then reimplemented in the client.
 *  - It fits the addressing the rest of the API already has. A score is a resource with an id, and
 *    this is that resource's events, so it 404s and it scopes to an owner for the same reasons and
 *    by the same code as `GET /v1/scores/:id` does.
 *  - Additivity runs one way. A library-wide stream can be added later beside this one; a firehose
 *    cannot be narrowed once something depends on it.
 *
 * A read, and one that cannot become anything else — this handler is on the same `ScoreReader` as
 * every other read, and the only thing it can do with the bus is subscribe.
 */
function openEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  scoreId: Id,
): number {
  // The read serves two purposes and both are wanted: it 404s a score that is not there, rather
  // than opening a stream that could never carry anything, and it supplies the version the stream's
  // first frame announces. It also throws for a document this build cannot read (ADR-0028), which
  // is the right answer — a stream over a document we would refuse to serve is worth nothing.
  const record = context.reader.get(context.owner, scoreId);
  if (record === null) return send(response, noSuchScore(scoreId));
  return context.events.open(request, response, context.owner, scoreId, record.version);
}

/**
 * `POST /v1/imports` — submit a scan for OMR (ADR-0001: a job, not a request).
 *
 * The upload boundary (ADR-0029): the raw bytes are read under a cap, then **decoded** to prove they
 * are a PNG or JPEG within the dimension caps — the format from content, never from the declared
 * `Content-Type`. A body that is not a decodable image is refused here, not three layers deep inside
 * oemer. What passes is stored and enqueued, and the queued job comes back with `202 Accepted`: the
 * work has not happened yet, and the client polls `GET …/:id` or subscribes to `…/:id/events`.
 */
async function submitImport(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
): Promise<number> {
  if (context.imports === undefined || !context.imports.available) {
    return send(response, noImportPipeline());
  }

  const bytes = await readRawBody(request, response);
  if (bytes === TOO_LARGE) return 413;

  const check = validateUpload(bytes, { maxBytes: MAX_UPLOAD_BODY_BYTES });
  if (!check.ok) return send(response, badUpload(check.reason, check.message));

  const job = await context.imports.submit(context.owner, bytes);
  response.setHeader('location', `${IMPORTS}/${encodeURIComponent(job.id)}`);
  // 202, not 201: the resource exists but its result does not yet — recognition runs in the
  // background. The Location points at the job to poll, not at a finished artefact.
  return sendJson(response, 202, { job });
}

/**
 * `POST /v1/imports/:id/retry` — requeue a failed import (Q80). A retry is a user action, so it is
 * owner-scoped. A job that is not failed cannot be retried — a running or succeeded one is a 409
 * carrying its current status, the same "branch on data, not prose" shape an address miss has
 * (ADR-0008), so a client is told *why* rather than left to guess.
 */
function retryImport(response: ServerResponse, context: RouteContext, id: JobId): number {
  if (context.imports === undefined || !context.imports.available) {
    return send(response, noImportPipeline());
  }
  const existing = context.imports.reader.get(context.owner, id);
  if (existing === null) return send(response, noSuchImport(id));
  if (existing.status !== 'failed') {
    return send(
      response,
      problem(409, 'job-not-retryable', `import ${JSON.stringify(id)} is ${existing.status}, not failed`, {
        detail: { kind: 'job-not-retryable', status: existing.status },
      }),
    );
  }
  const job = context.imports.retry(context.owner, id);
  // The read above passed, so a null here is a lost race (someone else moved it); re-report as a miss.
  if (job === null) return send(response, noSuchImport(id));
  return sendJson(response, 200, { job });
}

/**
 * `GET /v1/imports/:id/events` — the job's progress stream (ADR-0001's "subscribe"). The sibling of
 * the score event stream, and a read like it: a 404 for a job that is not there rather than a stream
 * that could never carry anything, and the job's current status seeds the first frame so opening the
 * connection is itself the catch-up.
 */
function openImportStream(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  id: JobId,
): number {
  if (context.imports === undefined) return send(response, noImportPipeline());
  const job = context.imports.reader.get(context.owner, id);
  if (job === null) return send(response, noSuchImport(id));
  return context.imports.streams.open(request, response, context.owner, id, job.status);
}

/**
 * `GET /v1/scores/:id/export?format=pdf&paper=a4&font=normal&instrument=concert` (ADR-0006, Q81).
 *
 * A read: the score comes through the `ScoreReader`, the bytes go through the `BlobStore`, and
 * nothing about it touches the score's `version`. Every parameter here is in the cache key, which
 * is the rule the query surface is allowed to grow by — **anything that changes the bytes is in
 * the key** — and an edit invalidates by bumping the version, so there is no invalidation call
 * for this handler to forget to make.
 *
 * Every parameter has a default and **none of them falls back silently**. A `paper=a5` answered
 * with an A4 page would be the same class of failure as an address snapping to the nearest note:
 * the caller gets the wrong thing and never finds out. So an unrecognised value is a 422 carrying
 * the list of what there is.
 */
async function exportScore(
  request: IncomingMessage,
  response: ServerResponse,
  context: RouteContext,
  scoreId: Id,
): Promise<number> {
  const query = queryOf(request);

  const format = parseExportFormat(query.get('format'));
  if (format === null) return send(response, unsupported('format', query.get('format'), EXPORT_FORMATS));

  const instrument = parseExportInstrument(query.get('instrument'));
  if (instrument === null) {
    return send(response, unsupported('instrument', query.get('instrument'), EXPORT_INSTRUMENTS));
  }

  const paper = parseExportPaper(query.get('paper'));
  if (paper === null) return send(response, unsupported('paper', query.get('paper'), EXPORT_PAPERS));

  const font = parseExportFont(query.get('font'));
  if (font === null) return send(response, unsupported('font', query.get('font'), EXPORT_FONTS));

  const outcome = await context.exporter.export(context.owner, scoreId, {
    format,
    instrument,
    paper,
    font,
  });
  if (!outcome.ok) return send(response, noSuchScore(scoreId));
  return sendArtefact(response, outcome.artefact);
}

/**
 * 422 rather than 400: the request was perfectly readable, it asked for something this build
 * cannot produce. The list of what it *can* comes along, the same way an address miss ships the
 * bar's real onsets — an agent should branch on data rather than on prose (ADR-0008).
 */
function unsupported(what: string, requested: string | null, supported: readonly string[]): Problem {
  const kind = `unsupported-${what}`;
  return problem(
    422,
    kind,
    `${JSON.stringify(requested ?? '')} is not an export ${what} this build can produce; try ${supported.join(' or ')}`,
    { detail: { kind, requested, supported: [...supported] } },
  );
}

function sendArtefact(response: ServerResponse, artefact: Artefact): number {
  response.writeHead(200, {
    'content-type': artefact.contentType,
    'content-length': artefact.bytes.length,
    // Sanitised at the source, because the stem is the chart's title and a title is user text.
    'content-disposition': `attachment; filename="${artefact.filename}"`,
    'x-content-type-options': 'nosniff',
  });
  response.end(artefact.bytes);
  return 200;
}

function noSuchScore(scoreId: Id): Problem {
  return problem(404, 'no-such-score', `there is no score with the id ${JSON.stringify(scoreId)}`);
}

function noSuchImport(id: JobId): Problem {
  return problem(404, 'no-such-import', `there is no import job with the id ${JSON.stringify(id)}`);
}

/** This build was started without an OMR worker, so import is unavailable (but nothing else is). */
function noImportPipeline(): Problem {
  return problem(
    503,
    'worker-unavailable',
    'this server was started without an OMR worker, so import is unavailable; every other feature works',
  );
}

/**
 * An upload the boundary refused (ADR-0029). The `too-large` case is a 413 (it is about size, like
 * `readJsonBody`'s cap); everything else is a 422 — the request was readable, its content was not a
 * usable image. The reason travels in `detail` so a client branches on it (ADR-0008).
 */
function badUpload(reason: UploadRejection, message: string): Problem {
  const status = reason === 'too-large' ? 413 : 422;
  return problem(status, `bad-upload-${reason}`, message, { detail: { kind: 'bad-upload', reason } });
}

function match(path: string, pattern: RegExp): Id | null {
  const found = pattern.exec(path);
  return found?.[1] === undefined ? null : decodeURIComponent(found[1]);
}

/**
 * A batch, from whatever the client sent. Both shapes are accepted: `operation` for the common
 * single edit, `operations` for a transactional list (ADR-0008). **One code path applies them**, so
 * a batch of one cannot behave differently from a lone operation — which is the sort of divergence
 * that only shows up in the one case nobody tested.
 */
export function batchFrom(body: unknown): Batch {
  const source = (body ?? {}) as {
    operation?: Operation;
    operations?: Operation[];
    expectedVersion?: number;
  };
  const operations = source.operations ?? (source.operation === undefined ? [] : [source.operation]);
  return {
    operations: Array.isArray(operations) ? operations : [],
    ...(source.expectedVersion === undefined ? {} : { expectedVersion: source.expectedVersion }),
  };
}

/**
 * The expected version an undo/redo carries. `undefined` when the body omits it — the applier
 * refuses that with the same `missing-expected-version` a write gets, rather than this file guessing
 * a version the caller never established (KAN-607).
 */
function expectedVersionFrom(body: unknown): number | undefined {
  const value = (body as { expectedVersion?: unknown } | null)?.expectedVersion;
  return typeof value === 'number' ? value : undefined;
}

/** The id a duplicate should take, when the client names one; otherwise the applier mints it. */
function newIdFrom(body: unknown): string | undefined {
  const value = (body as { id?: unknown } | null)?.id;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const MALFORMED = Symbol('malformed');

async function readJsonBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<unknown | typeof MALFORMED> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      // Answer and hang up. Without closing the connection the client goes on sending the rest of a
      // body we have already refused, and the request sits there until a timeout — which turns a
      // rejection into a stall, and a stall is a worse failure than the one being prevented.
      response.setHeader('connection', 'close');
      send(response, problem(413, 'body-too-large', `a request body is capped at ${MAX_BODY_BYTES} bytes`));
      request.destroy();
      return MALFORMED;
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 400 rather than 422: this one was not even a request the server could read.
    send(response, problem(400, 'malformed-json', 'the request body is not valid JSON'));
    return MALFORMED;
  }
}

/** The raw-body reader's "I already answered 413" sentinel, the binary sibling of `MALFORMED`. */
const TOO_LARGE = Symbol('too-large');

/**
 * Read a raw binary body (an image upload), capped like `readJsonBody` but at the larger image cap.
 * No parsing: an upload is bytes, and what those bytes *are* is `validateUpload`'s decision, not this
 * reader's. On the cap it answers 413 and hangs up rather than draining a body it has already
 * refused, for the same reason `readJsonBody` does.
 */
async function readRawBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Buffer | typeof TOO_LARGE> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_UPLOAD_BODY_BYTES) {
      response.setHeader('connection', 'close');
      send(response, problem(413, 'body-too-large', `an upload is capped at ${MAX_UPLOAD_BODY_BYTES} bytes`));
      request.destroy();
      return TOO_LARGE;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function methodNotAllowed(response: ServerResponse, allowed: string[]): number {
  response.setHeader('allow', allowed.join(', '));
  return send(response, problem(405, 'method-not-allowed', `try ${allowed.join(' or ')}`));
}

export function pathOf(request: IncomingMessage): string {
  const raw = request.url ?? '/';
  const query = raw.indexOf('?');
  return query === -1 ? raw : raw.slice(0, query);
}

/** The other half of the URL. Parsed here rather than in a handler, so routing sees only the path. */
export function queryOf(request: IncomingMessage): URLSearchParams {
  const raw = request.url ?? '/';
  const query = raw.indexOf('?');
  return new URLSearchParams(query === -1 ? '' : raw.slice(query + 1));
}

export function send(response: ServerResponse, outcome: Problem): number {
  return sendJson(response, outcome.status, outcome.body);
}

export function sendJson(response: ServerResponse, status: number, body: unknown): number {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    // No CORS headers at all, and a wildcard least of all (ADR-0029). The UI is served same-origin.
    'x-content-type-options': 'nosniff',
  });
  response.end(text);
  return status;
}
