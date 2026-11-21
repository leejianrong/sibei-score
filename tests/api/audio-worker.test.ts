import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, memoryAudioJobStore, memoryBlobStore, silentLogger } from '@sibei/api';
import type { Api, AudioResultImporter, ManagedBlobStore, PresigningBlobStore } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';

/**
 * The audio worker protocol end to end (SIB2-138), with a fake worker that speaks only the wire format in
 * the ADR-0034 amendment: claim, fetch the audio, heartbeat, complete or fail. No real transcription, and no
 * route but `/v1/worker/audio/*` — which is also the point of the credential tests at the bottom.
 */

const WORKER = 'sbsw_testcredential0123456789';
const NOTE_EVENTS = { schema_version: 1, source: { duration_s: 4 }, instrument: 'piano', producer: { name: 'fake' }, notes: [] };

let api: Api;
let base: string;
let blobs: ManagedBlobStore;
let clock: { at: number };
let imported: unknown[];
let importer: AudioResultImporter;

function boot(extra: { blobs?: ManagedBlobStore; maxAttempts?: number } = {}) {
  clock = { at: Date.parse('2026-12-01T10:00:00Z') };
  const now = () => new Date(clock.at);
  imported = [];
  importer = {
    async importResult(job, noteEvents) {
      imported.push({ job: job.id, noteEvents });
      return { ok: true, scoreId: `score-for-${job.id}` };
    },
  };
  blobs = extra.blobs ?? memoryBlobStore();
  api = createApi({
    store: openSqliteStore({ filename: ':memory:' }),
    blobs,
    audioJobs: memoryAudioJobStore({ now }),
    audioWorker: { tokens: [WORKER], now, ...(extra.maxAttempts === undefined ? {} : { maxAttempts: extra.maxAttempts }) },
    audioImporter: { importResult: (job, doc) => importer.importResult(job, doc) },
    logger: silentLogger,
  });
}

beforeEach(async () => {
  boot();
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
});
afterEach(async () => {
  await api.close();
});

interface Reply {
  status: number;
  body: any;
}
async function http(method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; raw?: Buffer } = {}): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
    ...(init.raw !== undefined ? { body: new Uint8Array(init.raw) } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : text.startsWith('{') ? JSON.parse(text) : text };
}
const asWorker = { authorization: `Bearer ${WORKER}` };
const worker = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  http(method, `/v1/worker/audio${path}`, { ...(body === undefined ? {} : { body }), headers: { ...asWorker, ...headers } });

/** A user uploads audio and gets a queued job. */
async function queuedJob(): Promise<string> {
  const declared = await http('POST', '/v1/audio/jobs', { body: { filename: 't.wav', contentType: 'audio/wav', sizeBytes: 6, instrument: 'piano' } });
  const id = declared.body.job.id as string;
  await http('PUT', declared.body.upload.url, { raw: Buffer.from('RIFFxx'), headers: { 'content-type': 'audio/wav' } });
  await http('POST', `/v1/audio/jobs/${id}/uploaded`, { body: {} });
  return id;
}

describe('a fake worker, end to end', () => {
  it('claims, downloads, heartbeats and completes, and the user sees the job succeed with a score', async () => {
    const id = await queuedJob();

    const none = await worker('POST', '/claim', {});
    expect(none.status).toBe(200);
    const job = none.body.job;
    expect(job).toMatchObject({
      id,
      attempt: 1,
      heartbeatIntervalSeconds: 30,
      params: { instrument: 'piano', declaredDurationSeconds: null },
      audio: { method: 'GET', viaApi: true, contentType: 'audio/wav', sizeBytes: 6 },
    });
    expect(job.resultUpload).toBeUndefined(); // local store: no presigning, so the result goes inline

    // The user sees it running, but never the lease token.
    const during = await http('GET', `/v1/audio/jobs/${id}`);
    expect(during.body.job.status).toBe('running');
    expect(during.body.job).not.toHaveProperty('leaseToken');

    // The audio, through the API's own route, authorised by the lease.
    const audio = await http('GET', job.audio.url, { headers: { ...asWorker, ...job.audio.headers } });
    expect(audio.body).toBe('RIFFxx');
    expect((await http('GET', job.audio.url, { headers: { ...asWorker, 'x-lease-token': 'wrong' } })).status).toBe(404);

    clock.at += 30_000;
    const beat = await worker('POST', `/jobs/${id}/heartbeat`, { leaseToken: job.leaseToken, progress: { stage: 'transcribing', fraction: 0.5 } });
    expect(beat.status).toBe(200);
    expect(beat.body).toMatchObject({ cancelled: false, leaseExpiresAt: '2026-12-01T10:02:30Z' });
    expect((await http('GET', `/v1/audio/jobs/${id}`)).body.job.progress).toEqual({ stage: 'transcribing', fraction: 0.5 });

    const done = await worker('POST', `/jobs/${id}/complete`, { leaseToken: job.leaseToken, durationSeconds: 4.2, result: { inline: NOTE_EVENTS } });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ status: 'succeeded' });
    expect(imported).toEqual([{ job: id, noteEvents: NOTE_EVENTS }]);

    const after = (await http('GET', `/v1/audio/jobs/${id}`)).body.job;
    expect(after).toMatchObject({ status: 'succeeded', durationSeconds: 4.2, scoreId: `score-for-${id}`, result: NOTE_EVENTS });
    // Retention: the audio is gone the moment the job ended.
    expect(await blobs.stat((await http('GET', `/v1/audio/jobs/${id}`)).body.job.audioKey)).toBeNull();
  });

  it('answers a repeated complete with the same lease as the same success, importing once', async () => {
    const id = await queuedJob();
    const { job } = (await worker('POST', '/claim', {})).body;
    const body = { leaseToken: job.leaseToken, durationSeconds: 4, result: { inline: NOTE_EVENTS } };
    expect((await worker('POST', `/jobs/${id}/complete`, body)).status).toBe(200);
    const again = await worker('POST', `/jobs/${id}/complete`, body);
    expect(again).toMatchObject({ status: 200, body: { status: 'succeeded', alreadyCompleted: true } });
    expect(imported).toHaveLength(1);
  });

  it('meters the audio-seconds of a completed job exactly once, even when it is completed again or re-run', async () => {
    const id = await queuedJob();
    const usage = async () => (await http('GET', '/v1/audio/usage')).body.usage;
    expect(await usage()).toMatchObject({ seconds: 0, jobs: 0, periodStart: '2026-12-01T00:00:00Z', periodEnd: '2027-01-01T00:00:00Z' });

    const { job } = (await worker('POST', '/claim', {})).body;
    const body = { leaseToken: job.leaseToken, durationSeconds: 4.25, result: { inline: NOTE_EVENTS } };
    await worker('POST', `/jobs/${id}/complete`, body);
    await worker('POST', `/jobs/${id}/complete`, body); // a redelivered completion
    expect(await usage()).toMatchObject({ seconds: 4.25, jobs: 1 });
  });

  it('does not meter a job that failed or whose result the importer refused, and counts it once when a re-run then succeeds', async () => {
    const id = await queuedJob();
    const first = (await worker('POST', '/claim', {})).body.job;
    await worker('POST', `/jobs/${id}/fail`, { leaseToken: first.leaseToken, kind: 'engine-error', retryable: false });
    expect((await http('GET', '/v1/audio/usage')).body.usage).toMatchObject({ seconds: 0, jobs: 0 });

    // SIB2-200: Retry is refused once the audio is gone, so put it back to stand in for the user's re-upload.
    const audioKey = (await http('GET', `/v1/audio/jobs/${id}`)).body.job.audioKey;
    await blobs.put(audioKey, Buffer.alloc(8, 1));
    await http('POST', `/v1/audio/jobs/${id}/retry`);
    importer = { importResult: async () => ({ ok: false, kind: 'invalid-result', message: 'bad' }) };
    // The retried job's audio was dropped when it failed; the user would re-upload in practice. Here we only
    // need a lease on the same job id, which the retry gave us.
    const second = (await worker('POST', '/claim', {})).body.job;
    await worker('POST', `/jobs/${id}/complete`, { leaseToken: second.leaseToken, durationSeconds: 5, result: { inline: {} } });
    expect((await http('GET', '/v1/audio/usage')).body.usage).toMatchObject({ seconds: 0, jobs: 0 });
    await blobs.put(audioKey, Buffer.alloc(8, 1));
    await http('POST', `/v1/audio/jobs/${id}/retry`);
    importer = { importResult: async (job) => ({ ok: true, scoreId: `s-${job.id}` }) };
    const third = (await worker('POST', '/claim', {})).body.job;
    await worker('POST', `/jobs/${id}/complete`, { leaseToken: third.leaseToken, durationSeconds: 5, result: { inline: NOTE_EVENTS } });
    expect((await http('GET', '/v1/audio/usage')).body.usage).toMatchObject({ seconds: 5, jobs: 1 });
  });

  it('204s a claim when nothing is queued, and does not hand out a job that is still uploading', async () => {
    await http('POST', '/v1/audio/jobs', { body: { filename: 'x.wav', contentType: 'audio/wav', sizeBytes: 3 } });
    expect((await worker('POST', '/claim', {})).status).toBe(204);
  });

  it('records a non-retryable failure and drops the audio; a retryable one re-queues', async () => {
    const id = await queuedJob();
    const first = (await worker('POST', '/claim', {})).body.job;
    const requeued = await worker('POST', `/jobs/${id}/fail`, { leaseToken: first.leaseToken, kind: 'engine-error', message: 'oom', retryable: true });
    expect(requeued.body).toEqual({ status: 'queued' });
    const second = (await worker('POST', '/claim', {})).body.job;
    expect(second.attempt).toBe(2);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    const failed = await worker('POST', `/jobs/${id}/fail`, { leaseToken: second.leaseToken, kind: 'unsupported-audio', message: 'no stream', retryable: false });
    expect(failed.body).toEqual({ status: 'failed' });
    const view = (await http('GET', `/v1/audio/jobs/${id}`)).body.job;
    expect(view).toMatchObject({ status: 'failed', diagnosticKind: 'unsupported-audio', diagnostic: 'no stream' });
    expect(await blobs.stat(view.audioKey)).toBeNull();
    // The audio is gone, so Retry is refused (SIB2-200); with it held again, the owner can retry.
    const refused = await http('POST', `/v1/audio/jobs/${id}/retry`);
    expect(refused).toMatchObject({ status: 409, body: { error: { kind: 'audio-gone' } } });
    await blobs.put(view.audioKey, Buffer.alloc(8, 1));
    expect((await http('POST', `/v1/audio/jobs/${id}/retry`)).body.job.status).toBe('queued');
  });

  it('fails a job the importer refuses, keeping the result and saying why', async () => {
    importer = { importResult: async () => ({ ok: false, kind: 'invalid-result', message: 'not NoteEvents v1' }) };
    const id = await queuedJob();
    const { job } = (await worker('POST', '/claim', {})).body;
    const done = await worker('POST', `/jobs/${id}/complete`, { leaseToken: job.leaseToken, durationSeconds: 4, result: { inline: { nope: true } } });
    expect(done.body).toEqual({ status: 'failed' });
    expect((await http('GET', `/v1/audio/jobs/${id}`)).body.job).toMatchObject({ status: 'failed', diagnosticKind: 'invalid-result', diagnostic: 'not NoteEvents v1' });
  });

  it('re-queues a stalled claim, kills the old lease, and fails the job as worker-lost after three attempts', async () => {
    const id = await queuedJob();
    const first = (await worker('POST', '/claim', {})).body.job;

    clock.at += 119_000; // still inside the 120 s lease
    expect((await worker('POST', '/claim', {})).status).toBe(204);

    clock.at += 2_000; // now past it
    const second = (await worker('POST', '/claim', {})).body.job;
    expect(second).toMatchObject({ id, attempt: 2 });
    // The first worker comes back and is told to abandon the work.
    const stale = await worker('POST', `/jobs/${id}/heartbeat`, { leaseToken: first.leaseToken });
    expect(stale).toMatchObject({ status: 409, body: { error: { kind: 'lease-lost' } } });
    expect((await worker('POST', `/jobs/${id}/complete`, { leaseToken: first.leaseToken, durationSeconds: 1, result: { inline: NOTE_EVENTS } })).status).toBe(409);

    clock.at += 121_000;
    const third = (await worker('POST', '/claim', {})).body.job;
    expect(third.attempt).toBe(3);
    clock.at += 121_000;
    expect((await worker('POST', '/claim', {})).status).toBe(204); // the sweep ends it
    const view = (await http('GET', `/v1/audio/jobs/${id}`)).body.job;
    expect(view).toMatchObject({ status: 'failed', diagnosticKind: 'worker-lost', attempts: 3 });
    expect(await blobs.stat(view.audioKey)).toBeNull();
  });

  it('tells a worker its job was deleted, and refuses a bad body', async () => {
    const id = await queuedJob();
    const { job } = (await worker('POST', '/claim', {})).body;
    await http('DELETE', `/v1/audio/jobs/${id}`);
    expect((await worker('POST', `/jobs/${id}/heartbeat`, { leaseToken: job.leaseToken })).body).toMatchObject({ cancelled: true });
    expect((await worker('POST', `/jobs/${id}/complete`, { leaseToken: job.leaseToken, durationSeconds: 1, result: { inline: NOTE_EVENTS } })).status).toBe(409);
    expect((await worker('POST', `/jobs/x/complete`, { leaseToken: 'a', durationSeconds: 1, result: { inline: NOTE_EVENTS } })).body.error.kind).toBe('lease-lost');
    const other = await queuedJob();
    const claimed = (await worker('POST', '/claim', {})).body.job;
    const bad = await worker('POST', `/jobs/${other}/complete`, { leaseToken: claimed.leaseToken, durationSeconds: -1, result: {} });
    expect(bad).toMatchObject({ status: 400, body: { error: { kind: 'bad-request' } } });
  });
});

describe('the worker credential', () => {
  it('cannot read any user data: every user route refuses it, and it opens only /v1/worker/', async () => {
    // A score exists for the (local) user; the worker credential must not be able to see it.
    await http('POST', '/v1/scores', { body: { operations: [{ type: 'score.create', payload: { id: 's1', title: 'T' } }] } });
    for (const path of ['/v1/scores', '/v1/scores/s1', '/v1/audio/jobs', '/v1/imports', '/v1/me']) {
      const reply = await http('GET', path, { headers: asWorker });
      expect(reply.status).toBe(403);
      expect(reply.body.error.kind).toBe('forbidden');
    }
    expect((await http('POST', '/v1/scores/s1/ops', { body: {}, headers: asWorker })).status).toBe(403);
  });

  it('refuses a missing or unknown credential with 401, and a user credential with 403', async () => {
    expect((await http('POST', '/v1/worker/audio/claim', { body: {} })).status).toBe(401);
    expect((await http('POST', '/v1/worker/audio/claim', { body: {}, headers: { authorization: 'Bearer sbsw_nottheone' } })).status).toBe(401);
    const user = await http('POST', '/v1/worker/audio/claim', { body: {}, headers: { authorization: 'Bearer sbs_a_user_token' } });
    expect(user).toMatchObject({ status: 403, body: { error: { kind: 'forbidden' } } });
    expect((await http('POST', '/v1/worker/audio/claim', { body: {}, headers: { cookie: 'sibei_session=abc' } })).status).toBe(403);
  });

  it('does not exist at all on a server with no worker configured', async () => {
    await api.close();
    api = createApi({ store: openSqliteStore({ filename: ':memory:' }), logger: silentLogger });
    base = `http://127.0.0.1:${(await api.listen(0)).port}`;
    expect((await http('POST', '/v1/worker/audio/claim', { body: {}, headers: asWorker })).status).toBe(404);
    // ...and the user-facing audio API is fully there regardless: the worker being absent changes nothing.
    expect((await http('GET', '/v1/audio/jobs')).status).toBe(200);
  });
});

describe('with object storage (presigned transfer)', () => {
  /** A blob store that presigns by naming the key in the URL, so a test can play the bucket. */
  function presigning(): PresigningBlobStore {
    const inner = memoryBlobStore();
    const sign = (verb: 'PUT' | 'GET', key: string, headers: Record<string, string>) => ({
      url: `https://bucket.test/${verb}/${encodeURIComponent(key)}`,
      method: verb,
      headers,
      expiresAt: Date.now() + 60_000,
    });
    return {
      ...inner,
      presignPut: (key, o) => sign('PUT', key, o.contentType === undefined ? {} : { 'Content-Type': o.contentType }),
      presignGet: (key) => sign('GET', key, {}),
    };
  }
  const keyOf = (url: string) => decodeURIComponent(url.split('/').pop()!);

  it('hands out presigned GET and PUT, reads an uploaded result from the bucket, and never proxies the audio', async () => {
    await api.close();
    boot({ blobs: presigning() });
    base = `http://127.0.0.1:${(await api.listen(0)).port}`;

    const declared = await http('POST', '/v1/audio/jobs', { body: { filename: 't.wav', contentType: 'audio/wav', sizeBytes: 6 } });
    expect(declared.body.upload).toMatchObject({ viaApi: false, method: 'PUT' });
    // The client plays the bucket: the bytes land under the signed key, not through the API.
    await blobs.put(keyOf(declared.body.upload.url), Buffer.from('RIFFxx'));
    const id = declared.body.job.id as string;
    expect((await http('POST', `/v1/audio/jobs/${id}/uploaded`, { body: {} })).body.job.status).toBe('queued');

    const { job } = (await worker('POST', '/claim', {})).body;
    expect(job.audio).toMatchObject({ viaApi: false, method: 'GET' });
    expect(job.resultUpload).toMatchObject({ viaApi: false, method: 'PUT', headers: { 'Content-Type': 'application/json' } });
    expect((await blobs.get(keyOf(job.audio.url)))?.toString()).toBe('RIFFxx');

    // Before the upload happens, "uploaded" is a 400; after, the API reads the document from the bucket.
    const early = await worker('POST', `/jobs/${id}/complete`, { leaseToken: job.leaseToken, durationSeconds: 4, result: { uploaded: true } });
    expect(early.status).toBe(400);
    await blobs.put(keyOf(job.resultUpload.url), Buffer.from(JSON.stringify(NOTE_EVENTS)));
    const beat = await worker('POST', `/jobs/${id}/heartbeat`, { leaseToken: job.leaseToken });
    expect(beat.body.audio).toMatchObject({ method: 'GET', viaApi: false }); // refreshed each heartbeat
    const done = await worker('POST', `/jobs/${id}/complete`, { leaseToken: job.leaseToken, durationSeconds: 4, result: { uploaded: true } });
    expect(done.body).toEqual({ status: 'succeeded' });
    expect(imported).toEqual([{ job: id, noteEvents: NOTE_EVENTS }]);
    expect(await blobs.stat(keyOf(job.resultUpload.url))).toBeNull(); // the staged result is dropped too
  });
});
