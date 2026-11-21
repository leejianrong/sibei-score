import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AudioService } from '../audio/service.js';
import type { Owner } from '../store/repository.js';
import { problem } from './problems.js';
import type { Problem } from './problems.js';
import { MALFORMED, readJsonBody, send, sendJson } from './routes.js';

/**
 * The user-facing audio routes (SIB2-137): `/v1/audio/jobs`.
 *
 *   POST   /v1/audio/jobs               declare an upload -> 201 { job, upload } (where to put the bytes)
 *   PUT    /v1/audio/jobs/:id/content   local mode only: the bytes, through the API (presigned elsewhere)
 *   POST   /v1/audio/jobs/:id/uploaded  the bytes are there: check and queue -> 200 { job }
 *   GET    /v1/audio/jobs               this owner's jobs, newest first
 *   GET    /v1/audio/jobs/:id           one job, with its result once there is one
 *   POST   /v1/audio/jobs/:id/retry     requeue a failed job
 *   DELETE /v1/audio/jobs/:id           remove the job and its audio
 *   GET    /v1/audio/usage              this owner's audio-seconds this period (SIB2-139)
 *
 * Every one is owner-scoped through the service, and none can reach the worker's lease token: a job is
 * handed to a user without it (`withoutLease`). The worker's own routes are a separate family under
 * `/v1/worker/` with a separate credential (SIB2-138). Returns `null` for a path that is not audio's, so
 * the main router carries on.
 */

export async function audioRoute(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  path: string,
  owner: Owner,
  audio: AudioService,
): Promise<number | null> {
  if (path === '/v1/audio/jobs') {
    if (method === 'GET') return sendJson(response, 200, { jobs: await audio.reader.list(owner) });
    if (method === 'POST') return await declare(request, response, owner, audio);
    return notAllowed(response, ['GET', 'POST']);
  }

  if (path === '/v1/audio/usage') {
    if (method !== 'GET') return notAllowed(response, ['GET']);
    return sendJson(response, 200, { usage: await audio.usage(owner) });
  }

  const parts = /^\/v1\/audio\/jobs\/([^/]+)(?:\/(content|uploaded|retry))?$/.exec(path);
  if (parts === null) return null;
  const id = decodeURIComponent(parts[1]!);
  const action = parts[2];

  if (action === undefined) {
    if (method === 'GET') {
      const job = await audio.reader.get(owner, id);
      return job === null ? send(response, noSuchJob(id)) : sendJson(response, 200, { job: withoutLease(job) });
    }
    if (method === 'DELETE') {
      if (!(await audio.remove(owner, id))) return send(response, noSuchJob(id));
      response.writeHead(204).end();
      return 204;
    }
    return notAllowed(response, ['GET', 'DELETE']);
  }

  if (method !== (action === 'content' ? 'PUT' : 'POST')) {
    return notAllowed(response, [action === 'content' ? 'PUT' : 'POST']);
  }

  if (action === 'content') {
    const bytes = await readCapped(request, response, audio.limits.maxBytes);
    if (bytes === null) return 413;
    const job = await audio.receive(owner, id, bytes);
    if (job === null) return send(response, noSuchJob(id));
    response.writeHead(204).end();
    return 204;
  }

  if (action === 'uploaded') {
    const result = await audio.confirm(owner, id);
    if (result.ok) return sendJson(response, 200, { job: withoutLease(result.job) });
    if (result.kind === 'no-such-job') return send(response, noSuchJob(id));
    if (result.kind === 'audio-too-large') {
      return send(response, problem(413, 'audio-too-large', result.message, { detail: { maxBytes: result.maxBytes } }));
    }
    return send(response, problem(409, 'audio-not-uploaded', result.message));
  }

  const job = await audio.retry(owner, id);
  if (job === null) {
    const existing = await audio.reader.get(owner, id);
    if (existing === null) return send(response, noSuchJob(id));
    return send(
      response,
      problem(409, 'audio-job-not-retryable', `audio job ${JSON.stringify(id)} is ${existing.status}; only a failed job can be retried`),
    );
  }
  return sendJson(response, 200, { job: withoutLease(job) });
}

async function declare(
  request: IncomingMessage,
  response: ServerResponse,
  owner: Owner,
  audio: AudioService,
): Promise<number> {
  const body = await readJsonBody(request, response);
  if (body === MALFORMED) return 400;
  const result = await audio.create(owner, (body ?? {}) as Record<string, unknown>);
  if (!result.ok) {
    if (result.kind === 'audio-too-large') {
      return send(response, problem(413, 'audio-too-large', result.message, { detail: { maxBytes: result.maxBytes } }));
    }
    if (result.kind === 'unsupported-audio-type') {
      return send(response, problem(422, 'unsupported-audio-type', result.message, { detail: { allowed: result.allowed } }));
    }
    return send(response, problem(422, 'validation', result.message));
  }
  response.setHeader('location', `/v1/audio/jobs/${encodeURIComponent(result.job.id)}`);
  return sendJson(response, 201, { job: withoutLease(result.job), upload: result.upload });
}

/** The lease token is the worker's; a user's view of a job never carries it. */
function withoutLease<T extends { leaseToken?: unknown }>(job: T): Omit<T, 'leaseToken'> {
  const { leaseToken: _leaseToken, ...rest } = job;
  return rest;
}

function noSuchJob(id: string): Problem {
  return problem(404, 'no-such-audio-job', `there is no audio job with the id ${JSON.stringify(id)}`);
}

function notAllowed(response: ServerResponse, allowed: string[]): number {
  response.setHeader('allow', allowed.join(', '));
  return send(response, problem(405, 'method-not-allowed', `try ${allowed.join(' or ')}`));
}

/** A raw body under `max` bytes; answers 413 and hangs up (like the image reader) when it is over. */
async function readCapped(request: IncomingMessage, response: ServerResponse, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > max) {
      response.setHeader('connection', 'close');
      send(response, problem(413, 'audio-too-large', `audio is capped at ${max} bytes`, { detail: { maxBytes: max } }));
      request.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
