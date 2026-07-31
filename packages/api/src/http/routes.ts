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
import type { Applier } from '../ops/applier.js';
import type { Batch, Operation } from '../ops/operations.js';
import type { Owner, ScoreLibrary, ScoreReader } from '../store/repository.js';
import { problem } from './problems.js';
import type { Problem } from './problems.js';

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
  owner: Owner;
}

/** A body larger than this is refused unread. An op batch is kilobytes (ADR-0029: real caps). */
export const MAX_BODY_BYTES = 1_000_000;

const SCORES = '/v1/scores';

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

  const opsFor = match(path, /^\/v1\/scores\/([^/]+)\/ops$/);
  if (opsFor !== null) {
    if (method !== 'POST') return methodNotAllowed(response, ['POST']);
    const body = await readJsonBody(request, response);
    if (body === MALFORMED) return 400;
    return sendJson(response, 200, context.applier.apply(context.owner, opsFor, batchFrom(body)));
  }

  return send(response, problem(404, 'no-such-route', `nothing at ${path}`));
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
