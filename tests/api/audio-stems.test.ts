import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, memoryAudioJobStore, memoryBlobStore, silentLogger } from '@sibei/api';
import type { Api } from '@sibei/api';
import { openSqliteJobStore, openSqliteStore } from '@sibei/api/sqlite';
import { fullBandChart } from '@sibei/fixtures';
import { allStaves, scoreMetrics } from '@sibei/model';
import type { NoteEvents, Score } from '@sibei/model';
import { scoreToStems } from '@sibei/synth';

/**
 * Several stems in one result (SIB2-147, ADR-0034 amendment). Synthetic stems only: the audio engine has no
 * multi-stem producer yet, so the fake worker delivers a four-stem mix made from our own full-band fixture.
 * Everything goes over HTTP; the importer is the real one.
 */

const WORKER = 'sbsw_testcredential0123456789';
const stems = (level: 'clean' | 'light' = 'light'): NoteEvents[] => scoreToStems(fullBandChart(), { seed: 3, level });

let api: Api;
let base: string;

beforeEach(async () => {
  const now = () => new Date(Date.parse('2026-12-01T10:00:00Z'));
  api = createApi({
    store: openSqliteStore({ filename: ':memory:' }),
    jobs: openSqliteJobStore({ filename: ':memory:' }),
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

async function http(method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; raw?: Buffer; contentType?: string } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(init.body === undefined && init.raw === undefined ? {} : { 'content-type': init.contentType ?? 'application/json' }), ...init.headers },
    ...(init.raw !== undefined ? { body: new Uint8Array(init.raw) } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : text.startsWith('{') ? JSON.parse(text) : text };
}
const worker = (method: string, path: string, body?: unknown) =>
  http(method, `/v1/worker/audio${path}`, { ...(body === undefined ? {} : { body }), headers: { authorization: `Bearer ${WORKER}` } });

async function submit(): Promise<string> {
  const declared = await http('POST', '/v1/audio/jobs', { body: { filename: 'mix.wav', contentType: 'audio/wav', sizeBytes: 6 } });
  const id = declared.body.job.id as string;
  await http('PUT', declared.body.upload.url, { raw: Buffer.from('RIFFxx'), headers: { 'content-type': 'audio/wav' } });
  await http('POST', `/v1/audio/jobs/${id}/uploaded`, { body: {} });
  return id;
}
const show = async (id: string) => (await http('GET', `/v1/audio/jobs/${id}`)).body.job;
const complete = async (id: string, result: unknown, durationSeconds = 41) => {
  const claimed = (await worker('POST', '/claim', {})).body.job;
  return worker('POST', `/jobs/${id}/complete`, { leaseToken: claimed.leaseToken, durationSeconds, result });
};
const scoreOf = async (id: string): Promise<Score> => (await http('GET', `/v1/scores/${id}`)).body.score;

describe('the worker completes a job with several stems', () => {
  it('lands one multi-part score, with per-stem diagnostics, metered once', async () => {
    const id = await submit();
    const done = await complete(id, { inline: { stems: stems() } });
    expect(done).toMatchObject({ status: 200, body: { status: 'succeeded' } });

    const job = await show(id);
    expect(job.status).toBe('succeeded');
    expect(job.diagnostic).toContain('piano: hand-split:');
    expect(job.diagnostic).toContain('4 stems');

    const score = await scoreOf(job.scoreId);
    expect(score.id).toBe(`audio-${id}`);
    expect(score.parts.map((p) => p.name)).toEqual(['Voice', 'Piano', 'Bass', 'Drums']);
    expect(score.meta.layout).toBe('score');
    expect(allStaves(score)).toHaveLength(5);
    expect(scoreMetrics(score).every((m) => m.valid)).toBe(true);

    // Four stems cost the audio once: the job's seconds, not four times.
    expect((await http('GET', '/v1/audio/usage')).body.usage).toMatchObject({ seconds: 41, jobs: 1 });
  });

  it('is idempotent on redelivery: one draft, nothing metered twice', async () => {
    const id = await submit();
    const claimed = (await worker('POST', '/claim', {})).body.job;
    const body = { leaseToken: claimed.leaseToken, durationSeconds: 41, result: { inline: { stems: stems() } } };
    await worker('POST', `/jobs/${id}/complete`, body);
    const first = (await show(id)).scoreId;
    expect((await worker('POST', `/jobs/${id}/complete`, body)).body).toMatchObject({ alreadyCompleted: true });
    expect((await show(id)).scoreId).toBe(first);
    expect((await http('GET', '/v1/scores')).body.scores).toHaveLength(1);
    expect((await http('GET', '/v1/audio/usage')).body.usage).toMatchObject({ jobs: 1 });
  });

  it('treats a one-element stems set exactly as the single document', async () => {
    const [voice] = stems();
    const id = await submit();
    await complete(id, { inline: { stems: [voice] } });
    const score = await scoreOf((await show(id)).scoreId);
    expect(score.parts).toHaveLength(1);
    expect(score.meta.layout).not.toBe('score');
  });

  it('keeps a guitar stem as a chord part with a warning', async () => {
    const all = stems();
    const guitar = { ...all[0]!, instrument: 'guitar' as const };
    const id = await submit();
    await complete(id, { inline: { stems: [...all, guitar] } });
    const job = await show(id);
    expect(job.status).toBe('succeeded');
    expect(job.diagnostic).toContain('guitar: unsupported-instrument:');
    expect((await scoreOf(job.scoreId)).parts.map((p) => p.name)).toEqual(['Voice', 'Guitar', 'Piano', 'Bass', 'Drums']);
  });
});

describe('a bad set fails the whole job, for good, and commits nothing', () => {
  async function refused(result: unknown) {
    const id = await submit();
    const done = await complete(id, result);
    expect(done.body.status).toBe('failed');
    const job = await show(id);
    expect(job).toMatchObject({ status: 'failed', diagnosticKind: 'invalid-result', scoreId: null });
    expect((await http('GET', '/v1/scores')).body.scores).toHaveLength(0);
    expect((await http('GET', '/v1/audio/usage')).body.usage).toMatchObject({ seconds: 0, jobs: 0 });
    return job;
  }

  it('names the malformed stem', async () => {
    const all = stems();
    all[2] = { ...all[2]!, notes: [{ ...all[2]!.notes[0]!, offset_s: 0 }] } as NoteEvents;
    expect((await refused({ inline: { stems: all } })).diagnostic).toContain('stems[2]');
  });

  it('names the stem whose source hash differs', async () => {
    const all = stems();
    all[1] = { ...all[1]!, source: { ...all[1]!.source, sha256: 'f'.repeat(64) } };
    expect((await refused({ inline: { stems: all } })).diagnostic).toContain('stems[1].source.sha256');
  });

  it('refuses a different duration, more than 12 stems, and an empty set', async () => {
    const all = stems();
    all[3] = { ...all[3]!, source: { ...all[3]!.source, duration_s: 999 } };
    expect((await refused({ inline: { stems: all } })).diagnostic).toContain('stems[3].source.duration_s');
    await refused({ inline: { stems: Array.from({ length: 13 }, () => all[0]!) } });
    await refused({ inline: { stems: [] } });
  });
});

describe('POST /v1/imports with several stems', () => {
  async function settle(id: string): Promise<Record<string, any>> {
    for (let i = 0; i < 300; i++) {
      const job = (await http('GET', `/v1/imports/${id}`)).body.job;
      if (job.status === 'succeeded' || job.status === 'failed') return job;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('did not settle');
  }

  it('takes a JSON array body', async () => {
    const created = await http('POST', '/v1/imports', { body: stems() });
    expect(created.status).toBe(202);
    const job = await settle(created.body.job.id);
    expect(job.status).toBe('succeeded');
    expect((await scoreOf(job.scoreId)).parts.map((p) => p.name)).toEqual(['Voice', 'Piano', 'Bass', 'Drums']);
  });

  it('takes a multipart upload of several files', async () => {
    const boundary = 'xBOUNDARYx';
    const parts = stems().map(
      (s, i) => `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="stem${i}.json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(s)}\r\n`,
    );
    const raw = Buffer.from(`${parts.join('')}--${boundary}--\r\n`);
    const created = await http('POST', '/v1/imports', { raw, contentType: `multipart/form-data; boundary=${boundary}` });
    expect(created.status).toBe(202);
    expect((await settle(created.body.job.id)).status).toBe('succeeded');
  });

  it('refuses a set that is not one recording with a 422 naming the stem, storing nothing', async () => {
    const all = stems();
    all[1] = { ...all[1]!, source: { ...all[1]!.source, sha256: 'e'.repeat(64) } };
    const refusal = await http('POST', '/v1/imports', { body: all });
    expect(refusal.status).toBe(422);
    expect(JSON.stringify(refusal.body)).toContain('stems[1].source.sha256');
    expect((await http('GET', '/v1/imports')).body.jobs).toHaveLength(0);
  });

  it('still takes a single document body unchanged', async () => {
    const created = await http('POST', '/v1/imports', { body: stems()[2] });
    expect(created.status).toBe(202);
    expect((await settle(created.body.job.id)).status).toBe('succeeded');
  });
});
