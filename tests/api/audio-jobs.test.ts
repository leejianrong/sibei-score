import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, memoryAudioJobStore, memoryBlobStore, silentLogger } from '@sibei/api';
import type { Api } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';

/**
 * The audio-job routes (SIB2-137), over a real socket and with **no audio worker at all** — the card's
 * "the API works with the audio worker stopped". Local mode: no presigning, so the bytes go through the
 * API's own `PUT …/content`.
 */

let api: Api;
let base: string;
let blobs: ReturnType<typeof memoryBlobStore>;
let audioJobs: ReturnType<typeof memoryAudioJobStore>;
const store = () => openSqliteStore({ filename: ':memory:' });

beforeEach(async () => {
  blobs = memoryBlobStore();
  audioJobs = memoryAudioJobStore();
  api = createApi({
    store: store(),
    blobs,
    audioJobs,
    audioLimits: { maxBytes: 1000 },
    logger: silentLogger,
  });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
});
afterEach(async () => {
  await api.close();
});

async function call(method: string, path: string, body?: unknown, raw?: Buffer) {
  const response = await fetch(`${base}${path}`, {
    method,
    ...(raw !== undefined
      ? { body: new Uint8Array(raw), headers: { 'content-type': 'audio/wav' } }
      : body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as Record<string, any>) };
}

const declare = (extra: Record<string, unknown> = {}) =>
  call('POST', '/v1/audio/jobs', { filename: 'take.wav', contentType: 'audio/wav', sizeBytes: 8, durationSeconds: 3.5, ...extra });

describe('audio jobs without a worker', () => {
  it('declares an upload, takes the bytes through the API, and queues the job', async () => {
    const created = await declare({ instrument: 'piano' });
    expect(created.status).toBe(201);
    const job = created.body!.job;
    expect(job).toMatchObject({ status: 'awaiting-upload', filename: 'take.wav', instrument: 'piano' });
    expect(job).not.toHaveProperty('leaseToken');
    expect(created.body!.upload).toMatchObject({ method: 'PUT', viaApi: true, url: `/v1/audio/jobs/${job.id}/content` });

    // Confirming before the bytes arrive is refused, and says why.
    const early = await call('POST', `/v1/audio/jobs/${job.id}/uploaded`);
    expect(early.status).toBe(409);
    expect(early.body!.error.kind).toBe('audio-not-uploaded');

    expect((await call('PUT', created.body!.upload.url, undefined, Buffer.alloc(8, 1))).status).toBe(204);
    const queued = await call('POST', `/v1/audio/jobs/${job.id}/uploaded`);
    expect(queued.status).toBe(200);
    expect(queued.body!.job).toMatchObject({ status: 'queued', sizeBytes: 8 });
    // Confirming again is the same answer, not an error.
    expect((await call('POST', `/v1/audio/jobs/${job.id}/uploaded`)).body!.job.status).toBe('queued');

    expect((await call('GET', '/v1/audio/jobs')).body!.jobs.map((j: { id: string }) => j.id)).toEqual([job.id]);
    expect((await call('GET', `/v1/audio/jobs/${job.id}`)).body!.job.status).toBe('queued');
  });

  it('refuses what the boundary should: a non-audio type, a bad size, too many bytes', async () => {
    const wrongType = await declare({ contentType: 'text/html' });
    expect(wrongType.status).toBe(422);
    expect(wrongType.body!.error.kind).toBe('unsupported-audio-type');
    expect(wrongType.body!.error.detail.allowed).toContain('audio/wav');

    expect((await declare({ sizeBytes: 0 })).body!.error.kind).toBe('validation');
    expect((await declare({ sizeBytes: 'big' })).status).toBe(422);
    const huge = await declare({ sizeBytes: 5000 });
    expect(huge.status).toBe(413);
    expect(huge.body!.error).toMatchObject({ kind: 'audio-too-large', detail: { maxBytes: 1000 } });

    const created = await declare();
    const over = await call('PUT', created.body!.upload.url, undefined, Buffer.alloc(2000));
    expect(over.status).toBe(413);
  });

  it('only retries a failed job, and says so otherwise', async () => {
    const created = await declare();
    const retry = await call('POST', `/v1/audio/jobs/${created.body!.job.id}/retry`);
    expect(retry.status).toBe(409);
    expect(retry.body!.error.kind).toBe('audio-job-not-retryable');
    expect((await call('POST', '/v1/audio/jobs/nope/retry')).status).toBe(404);
  });

  it('refuses Retry once the audio is deleted, and allows it while the audio is still held (SIB2-200)', async () => {
    const failHard = async () => {
      const created = await declare();
      const id = created.body!.job.id as string;
      await call('PUT', created.body!.upload.url, undefined, Buffer.alloc(8, 1));
      await call('POST', `/v1/audio/jobs/${id}/uploaded`);
      const claimed = await audioJobs.claim(60);
      await audioJobs.fail(id, claimed!.leaseToken!, { kind: 'engine-error', message: 'boom', retryable: false, maxAttempts: 3 });
      return id;
    };
    // Audio gone: refused, non-retryable, says to upload again.
    const gone = await failHard();
    const key = (await audioJobs.get('local', gone))!.audioKey;
    await blobs.delete(key);
    const refused = await call('POST', `/v1/audio/jobs/${gone}/retry`);
    expect(refused.status).toBe(409);
    expect(refused.body!.error.kind).toBe('audio-gone');
    expect(refused.body!.error.message).toMatch(/upload the recording again/);
    expect((await call('GET', `/v1/audio/jobs/${gone}`)).body!.job.status).toBe('failed');
    // Audio held (nothing deleted it): Retry requeues.
    const held = await failHard();
    const ok = await call('POST', `/v1/audio/jobs/${held}/retry`);
    expect(ok.status).toBe(200);
    expect(ok.body!.job.status).toBe('queued');
  });

  it('deletes a job and its audio, and answers 404 for one that is not there', async () => {
    const created = await declare();
    const id = created.body!.job.id as string;
    await call('PUT', created.body!.upload.url, undefined, Buffer.alloc(8, 1));
    expect((await call('DELETE', `/v1/audio/jobs/${id}`)).status).toBe(204);
    expect((await call('GET', `/v1/audio/jobs/${id}`)).body!.error.kind).toBe('no-such-audio-job');
    expect((await call('DELETE', `/v1/audio/jobs/${id}`)).status).toBe(404);
  });
});
