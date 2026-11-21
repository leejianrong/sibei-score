import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, memoryAudioJobStore, memoryBlobStore, silentLogger } from '@sibei/api';
import type { Api } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';

/**
 * The join (SIB2-E10): a user submits audio, the repo's fake worker claims and completes it with a real
 * NoteEvents fixture, and the user finds an editable draft. Everything goes through the HTTP API; the default
 * importer is the real one (no stub), so this is the whole path from `complete` to a score in the library.
 */

const WORKER = 'sbsw_testcredential0123456789';
const fixture = (name: string): any => JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'note-events', name), 'utf8'));

let api: Api;
let base: string;
let clock: { at: number };

beforeEach(async () => {
  clock = { at: Date.parse('2026-12-01T10:00:00Z') };
  const now = () => new Date(clock.at);
  api = createApi({
    store: openSqliteStore({ filename: ':memory:' }),
    blobs: memoryBlobStore(),
    audioJobs: memoryAudioJobStore({ now }),
    audioWorker: { tokens: [WORKER], now, leaseSeconds: 60, maxAttempts: 3 },
    logger: silentLogger,
  });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
});
afterEach(async () => {
  await api.close();
});

async function http(method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; raw?: Buffer } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
    ...(init.raw !== undefined ? { body: new Uint8Array(init.raw) } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : text.startsWith('{') ? JSON.parse(text) : text };
}
const worker = (method: string, path: string, body?: unknown) =>
  http(method, `/v1/worker/audio${path}`, { ...(body === undefined ? {} : { body }), headers: { authorization: `Bearer ${WORKER}` } });

async function submit(declaredDurationSeconds?: number): Promise<string> {
  const declared = await http('POST', '/v1/audio/jobs', {
    body: { filename: 'bass.wav', contentType: 'audio/wav', sizeBytes: 6, instrument: 'bass', ...(declaredDurationSeconds === undefined ? {} : { durationSeconds: declaredDurationSeconds }) },
  });
  const id = declared.body.job.id as string;
  await http('PUT', declared.body.upload.url, { raw: Buffer.from('RIFFxx'), headers: { 'content-type': 'audio/wav' } });
  await http('POST', `/v1/audio/jobs/${id}/uploaded`, { body: {} });
  return id;
}
const show = async (id: string) => (await http('GET', `/v1/audio/jobs/${id}`)).body.job;

describe('a completed audio job becomes a draft', () => {
  it('lands a draft with flagged notes, linked from the job, and meters the audio', async () => {
    const events = fixture('valid_bass_line.json');
    events.notes[3].confidence = 0.4; // a real fixture, with one note the transcriber was unsure of
    const id = await submit(9);

    const claimed = (await worker('POST', '/claim', {})).body.job;
    await worker('POST', `/jobs/${id}/heartbeat`, { leaseToken: claimed.leaseToken, progress: { stage: 'transcribing', fraction: 0.5 } });
    const done = await worker('POST', `/jobs/${id}/complete`, { leaseToken: claimed.leaseToken, durationSeconds: 8.87, result: { inline: events } });
    expect(done).toMatchObject({ status: 200, body: { status: 'succeeded' } });

    const job = await show(id);
    expect(job.status).toBe('succeeded');
    expect(job.scoreId).toEqual(expect.any(String));
    expect(job.diagnostic).toContain('inferred:');

    const score = (await http('GET', `/v1/scores/${job.scoreId}`)).body;
    expect(JSON.stringify(score)).toContain('low-confidence');
    expect((await http('GET', '/v1/scores')).body.scores.map((s: { id: string }) => s.id)).toContain(job.scoreId);
    expect((await http('GET', '/v1/audio/usage')).body.usage).toMatchObject({ seconds: 8.87, jobs: 1 });

    // A redelivered complete is a no-op: the same draft, nothing metered twice.
    const again = await worker('POST', `/jobs/${id}/complete`, { leaseToken: claimed.leaseToken, durationSeconds: 8.87, result: { inline: events } });
    expect(again.body).toMatchObject({ status: 'succeeded', alreadyCompleted: true });
    expect((await show(id)).scoreId).toBe(job.scoreId);
  });

  it('turns a silent recording into the empty one-bar draft with its warning shown', async () => {
    const id = await submit();
    const claimed = (await worker('POST', '/claim', {})).body.job;
    await worker('POST', `/jobs/${id}/complete`, { leaseToken: claimed.leaseToken, durationSeconds: 1, result: { inline: fixture('valid_silent_voice.json') } });
    const job = await show(id);
    expect(job.status).toBe('succeeded');
    expect(job.diagnostic).toContain('silent_input');
    const score = (await http('GET', `/v1/scores/${job.scoreId}`)).body.score;
    expect(score.bars).toHaveLength(1);
  });

  it('only warns when the durations disagree, and still lands the draft', async () => {
    const id = await submit(60);
    const claimed = (await worker('POST', '/claim', {})).body.job;
    await worker('POST', `/jobs/${id}/complete`, { leaseToken: claimed.leaseToken, durationSeconds: 8.87, result: { inline: fixture('valid_bass_line.json') } });
    const job = await show(id);
    expect(job.status).toBe('succeeded');
    expect(job.scoreId).not.toBeNull();
    expect(job.diagnostic).toContain('duration-mismatch');
  });

  it('fails a refused document for good, makes no score and meters nothing', async () => {
    const id = await submit();
    const claimed = (await worker('POST', '/claim', {})).body.job;
    const done = await worker('POST', `/jobs/${id}/complete`, { leaseToken: claimed.leaseToken, durationSeconds: 5, result: { inline: fixture('invalid_unknown_major.json') } });
    expect(done.body.status).toBe('failed');
    const job = await show(id);
    expect(job).toMatchObject({ status: 'failed', diagnosticKind: 'invalid-result', scoreId: null });
    expect((await http('GET', '/v1/scores')).body.scores).toHaveLength(0);
    expect((await http('GET', '/v1/audio/usage')).body.usage).toMatchObject({ seconds: 0, jobs: 0 });
  });

  it('after a lease is lost the first worker is refused and the second worker lands exactly one draft', async () => {
    const id = await submit();
    const first = (await worker('POST', '/claim', {})).body.job;
    clock.at += 61_000; // the lease lapses; the next claim sweeps it back to the queue
    const second = (await worker('POST', '/claim', {})).body.job;
    expect(second.id).toBe(id);
    expect(second.leaseToken).not.toBe(first.leaseToken);

    const stale = await worker('POST', `/jobs/${id}/complete`, { leaseToken: first.leaseToken, durationSeconds: 8.87, result: { inline: fixture('valid_bass_line.json') } });
    expect(stale.status).toBe(409);
    expect((await http('GET', '/v1/scores')).body.scores).toHaveLength(0);

    await worker('POST', `/jobs/${id}/complete`, { leaseToken: second.leaseToken, durationSeconds: 8.87, result: { inline: fixture('valid_bass_line.json') } });
    expect((await show(id)).status).toBe('succeeded');
    expect((await http('GET', '/v1/scores')).body.scores).toHaveLength(1);
    expect((await http('GET', '/v1/audio/usage')).body.usage).toMatchObject({ jobs: 1 });
  });
});
