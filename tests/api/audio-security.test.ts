import { describe, expect, it } from 'vitest';
import {
  QuotaError,
  createAudioService,
  createAudioWorkerService,
  createBlobSweeper,
  memoryAudioJobStore,
  memoryBlobLedger,
  memoryBlobStore,
  parseWorkerCredential,
  plausibleDuration,
} from '@sibei/api';
import type { ManagedBlobStore, PresigningBlobStore } from '@sibei/api';

/** The pre-launch security review's audio findings (SEC H4, M1, M2), against the services directly. */

const TOKEN = `sbsw_${'a'.repeat(40)}`;
const input = (extra: Record<string, unknown> = {}) => ({ contentType: 'audio/wav', sizeBytes: 100, ...extra });

/** A bucket that presigns by name, so a test can play the client writing to a signed key. */
function presigning(): PresigningBlobStore {
  const inner = memoryBlobStore();
  const sign = (method: 'PUT' | 'GET', key: string) => ({ url: `https://bucket.example/${key}`, method, headers: {}, expiresAt: Date.now() + 1000 });
  return { ...inner, presignPut: (key) => sign('PUT', key), presignGet: (key) => sign('GET', key) };
}

describe('H4: audio holds', () => {
  const hold = { maxInFlightJobs: 2, maxInFlightBytes: 250 };

  it('refuses a job past the in-flight count, then past the byte budget, and frees room when one is removed', async () => {
    const jobs = memoryAudioJobStore();
    const audio = createAudioService({ jobs, blobs: memoryBlobStore(), hold });
    const first = await audio.create('u', input());
    expect(first.ok).toBe(true);
    expect((await audio.create('u', input())).ok).toBe(true);
    await expect(audio.create('u', input())).rejects.toMatchObject({ quota: 'audio-jobs', limit: 2 });
    // another user is unaffected
    expect((await audio.create('v', input())).ok).toBe(true);
    if (first.ok) await audio.remove('u', first.job.id);
    await expect(audio.create('u', input({ sizeBytes: 200 }))).rejects.toBeInstanceOf(QuotaError);
    await expect(audio.create('u', input({ sizeBytes: 200 }))).rejects.toMatchObject({ quota: 'audio-bytes' });
  });

  it('refuses a body bigger than the size the job declared', async () => {
    const audio = createAudioService({ jobs: memoryAudioJobStore(), blobs: memoryBlobStore() });
    const made = await audio.create('u', input({ sizeBytes: 10 }));
    if (!made.ok) throw new Error('create failed');
    expect(await audio.receive('u', made.job.id, Buffer.alloc(11))).toBe('too-large');
    expect(await audio.receive('u', made.job.id, Buffer.alloc(10))).not.toBe('too-large');
  });

  it('sweeps jobs stuck awaiting-upload, with their objects', async () => {
    const jobs = memoryAudioJobStore();
    const blobs = memoryBlobStore();
    const ledger = memoryBlobLedger();
    const audio = createAudioService({ jobs, blobs, ledger });
    const made = await audio.create('u', input());
    if (!made.ok) throw new Error('create failed');
    await blobs.put(made.job.audioKey, Buffer.from('x'));
    let clock = Date.now();
    const sweeper = createBlobSweeper({ ledger, blobs, audioJobs: jobs, lifetimes: {}, now: () => new Date(clock) });
    expect((await sweeper.sweepOnce())['audio-upload']).toBe(0);
    clock += 61 * 60 * 1000;
    expect((await sweeper.sweepOnce())['audio-upload']).toBe(1);
    expect(await jobs.get('u', made.job.id)).toBeNull();
    expect(await blobs.get(made.job.audioKey)).toBeNull();
  });
});

describe('M1: presigned uploads', () => {
  it('confirms by copying onto a key no URL can write, so a late PUT changes nothing', async () => {
    const jobs = memoryAudioJobStore();
    const blobs = presigning();
    const ledger = memoryBlobLedger();
    const audio = createAudioService({ jobs, blobs, ledger });
    const made = await audio.create('u', input({ sizeBytes: 5 }));
    if (!made.ok) throw new Error('create failed');
    const uploadKey = new URL(made.upload.url).pathname.slice(1);
    expect(uploadKey).not.toBe(made.job.audioKey);
    await blobs.put(uploadKey, Buffer.from('audio'));
    expect((await audio.confirm('u', made.job.id)).ok).toBe(true);
    expect((await blobs.get(made.job.audioKey))?.toString()).toBe('audio');
    expect(await blobs.get(uploadKey)).toBeNull();
    // the client still holds the signed URL and writes again
    await blobs.put(uploadKey, Buffer.alloc(1000, 1));
    expect((await blobs.get(made.job.audioKey))?.toString()).toBe('audio');
    // both keys were ledgered, so the sweep and account deletion can find the stray one
    const keys = (await ledger.olderThan('audio', '9999-01-01T00:00:00Z', 10)).map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining([made.job.audioKey, uploadKey]));
  });
});

describe('M2: the worker credential', () => {
  async function runningJob(extra: Record<string, unknown> = {}, blobs: ManagedBlobStore = memoryBlobStore()) {
    const jobs = memoryAudioJobStore();
    const audio = createAudioService({ jobs, blobs });
    const made = await audio.create('victim', input({ sizeBytes: 3_000, ...extra }));
    if (!made.ok) throw new Error('create failed');
    await audio.receive('victim', made.job.id, Buffer.alloc(3_000));
    await audio.confirm('victim', made.job.id);
    const worker = createAudioWorkerService({ jobs, blobs, worker: { tokens: [`ci=${TOKEN}`], maxConcurrentClaims: 2 } });
    return { worker, jobs, id: made.job.id };
  }

  it('bounds reported duration by the declared length and the file size', async () => {
    expect(plausibleDuration({ declaredDurationSeconds: 100, sizeBytes: 10_000_000 })).toBe(200);
    expect(plausibleDuration({ declaredDurationSeconds: null, sizeBytes: 6_000 })).toBe(60);
    expect(plausibleDuration({ declaredDurationSeconds: null, sizeBytes: 1e12 })).toBe(86_400);
    const { worker } = await runningJob({ durationSeconds: 10 });
    const claimed = await worker.claim({});
    const done = await worker.complete(claimed!.id, { leaseToken: claimed!.leaseToken, durationSeconds: 80_000, result: { inline: {} } });
    expect(done).toMatchObject({ ok: false, kind: 'bad-request' });
  });

  it('answers a heartbeat the same for a lost lease and a deleted job', async () => {
    const { worker, jobs, id } = await runningJob();
    const claimed = await worker.claim({});
    const wrong = await worker.heartbeat(id, { leaseToken: 'not-the-lease' });
    await jobs.delete('victim', id);
    const gone = await worker.heartbeat(id, { leaseToken: claimed!.leaseToken });
    expect(wrong).toEqual(gone);
  });

  it('names credentials, accepts bare tokens, and says which one matched', () => {
    expect(parseWorkerCredential(`ci=${TOKEN}`)).toEqual({ name: 'ci', token: TOKEN });
    const bare = parseWorkerCredential(TOKEN);
    expect(bare.token).toBe(TOKEN);
    expect(bare.name).toMatch(/^token-[0-9a-f]{8}$/);
    const worker = createAudioWorkerService({ jobs: memoryAudioJobStore(), blobs: memoryBlobStore(), worker: { tokens: [`ci=${TOKEN}`] } });
    expect(worker.credentialOf(`Bearer ${TOKEN}`)).toBe('ci');
    expect(worker.credentialOf(`Bearer sbsw_${'b'.repeat(40)}`)).toBeNull();
  });

  it('holds a credential to a few concurrent long-polls', async () => {
    const { worker } = await runningJob();
    await worker.claim({}); // take the only job so the polls below find nothing
    const polls = [1, 2].map(() => worker.claim({ waitSeconds: 1, credential: 'ci' }));
    const started = Date.now();
    expect(await worker.claim({ waitSeconds: 30, credential: 'ci' })).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    await Promise.all(polls);
  });
});
