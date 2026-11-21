import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AudioWorkerService, WorkerResult } from '../audio/worker-service.js';
import { problem } from './problems.js';
import { MALFORMED, readJsonBody, send, sendJson } from './routes.js';

/**
 * The audio worker's routes (SIB2-138): `/v1/worker/audio/*`, the wire format of "Audio worker protocol
 * v1" in the ADR-0034 amendment.
 *
 *   POST /v1/worker/audio/claim                    -> 200 { job } | 204
 *   POST /v1/worker/audio/jobs/:id/heartbeat       -> 200 { leaseExpiresAt, cancelled, audio }
 *   POST /v1/worker/audio/jobs/:id/complete        -> 200 { status, alreadyCompleted? }
 *   POST /v1/worker/audio/jobs/:id/fail            -> 200 { status }
 *   GET  /v1/worker/audio/jobs/:id/content         -> the audio (local mode only; header x-lease-token)
 *
 * **This file is handed an `AudioWorkerService` and nothing else.** It has no score reader, no library and
 * no applier, so the worker credential that reaches it cannot touch any user's data by construction, the
 * way the user routes cannot reach a lease token. `server.ts` calls it only after the credential has been
 * checked, and before any user principal is resolved: a cookie or a user token never gets here.
 */

export async function workerRoute(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  path: string,
  worker: AudioWorkerService,
): Promise<number> {
  if (path === '/v1/worker/audio/claim') {
    if (method !== 'POST') return notAllowed(response, 'POST');
    const body = await readJsonBody(request, response);
    if (body === MALFORMED) return 400;
    const waitSeconds = (body as { waitSeconds?: unknown } | null)?.waitSeconds;
    const job = await worker.claim({
      ...(typeof waitSeconds === 'number' ? { waitSeconds } : {}),
      credential: worker.credentialOf(request.headers.authorization),
    });
    if (job === null) {
      response.writeHead(204).end();
      return 204;
    }
    return sendJson(response, 200, { job });
  }

  const parts = /^\/v1\/worker\/audio\/jobs\/([^/]+)\/(heartbeat|complete|fail|content)$/.exec(path);
  if (parts === null) return send(response, problem(404, 'no-such-route', `nothing at ${path}`));
  const id = decodeURIComponent(parts[1]!);
  const action = parts[2]!;

  if (action === 'content') {
    if (method !== 'GET') return notAllowed(response, 'GET');
    const header = request.headers['x-lease-token'];
    const audio = await worker.contentFor(id, typeof header === 'string' ? header : undefined);
    // The same answer for a job that is missing and one this lease does not hold: ids reveal nothing.
    if (audio === null) return send(response, problem(404, 'no-such-audio-job', 'no such job for that lease'));
    response.writeHead(200, {
      'content-type': audio.contentType,
      'content-length': audio.bytes.length,
      'x-content-type-options': 'nosniff',
    });
    response.end(audio.bytes);
    return 200;
  }

  if (method !== 'POST') return notAllowed(response, 'POST');
  const body = await readJsonBody(request, response, WORKER_BODY_BYTES);
  if (body === MALFORMED) return 400;
  const input = (body ?? {}) as { leaseToken: unknown; durationSeconds: unknown; result: unknown; progress?: unknown; kind?: unknown; message?: unknown; retryable?: unknown };

  switch (action) {
    case 'heartbeat':
      return answer(response, await worker.heartbeat(id, input));
    case 'complete':
      return answer(response, await worker.complete(id, input));
    default:
      return answer(response, await worker.fail(id, input));
  }
}

/** A `complete` with the NoteEvents inline is the biggest body this API reads; the service caps it again. */
const WORKER_BODY_BYTES = 8 * 1024 * 1024;

function answer<T>(response: ServerResponse, result: WorkerResult<T>): number {
  if (result.ok) return sendJson(response, 200, result.value);
  switch (result.kind) {
    case 'lease-lost':
      return send(response, problem(409, 'lease-lost', 'that lease is no longer yours: the job was re-queued or removed; abandon the work'));
    case 'no-such-job':
      return send(response, problem(404, 'no-such-audio-job', 'no such job'));
    case 'body-too-large':
      return send(response, problem(413, 'body-too-large', result.message));
    case 'invalid-result':
      return send(response, problem(422, 'invalid-result', result.message));
    default:
      return send(response, problem(400, 'bad-request', result.message));
  }
}

function notAllowed(response: ServerResponse, allowed: string): number {
  response.setHeader('allow', allowed);
  return send(response, problem(405, 'method-not-allowed', `try ${allowed}`));
}
