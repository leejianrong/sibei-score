import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApi, memoryAudioJobStore, silentLogger } from '@sibei/api';
import type { Api } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';

/**
 * The free-tier cap (SIB2-140): a refusal that says what to do, a listed user it does not touch, and a
 * limit that is configuration. The caller is the local owner (`local`), so a "paid" user is
 * `plans: { local: … }`. Each declared job reserves its declared length until it finishes or is deleted;
 * the next job is refused once finished work plus what is waiting reaches the allowance.
 */

const WORKER = 'sbsw_testcredential0123456789';
let api: Api | undefined;
let base = '';

async function boot(quota: { freeSeconds: number | null; plans?: Record<string, number | 'unlimited'> }) {
  const clock = { at: Date.parse('2026-12-10T10:00:00Z') };
  const now = () => new Date(clock.at);
  api = createApi({
    store: openSqliteStore({ filename: ':memory:' }),
    audioJobs: memoryAudioJobStore({ now }),
    audioWorker: { tokens: [WORKER], now },
    audioQuota: quota,
    logger: silentLogger,
  });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
}
afterEach(async () => {
  await api?.close();
  api = undefined;
});

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as any) };
}
const declare = (durationSeconds?: number) =>
  http('POST', '/v1/audio/jobs', {
    filename: 'a.wav',
    contentType: 'audio/wav',
    sizeBytes: 4,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
  });

describe('the free-tier cap', () => {
  it('refuses the next job once the allowance is reached, saying how much, until when, and what to do', async () => {
    await boot({ freeSeconds: 120 });
    expect((await declare(100)).status).toBe(201); // nothing reserved yet
    expect((await declare(10)).status).toBe(201); // 100 reserved, under 120
    expect((await declare(30)).status).toBe(201); // 110 reserved, under 120
    const over = await declare(5); // 140 reserved: over
    expect(over.status).toBe(403);
    expect(over.body.error.kind).toBe('quota-exceeded');
    expect(over.body.error.detail).toMatchObject({ quota: 'audio-seconds', limit: 120 });
    expect(over.body.error.detail.retryAfterSeconds).toBeGreaterThan(0);
    expect(over.body.error.message).toMatch(/renews on 2027-01-01/);
    expect(over.body.error.message).toMatch(/delete jobs you no longer need/);
  });

  it('counts finished work from the ledger, not only what is waiting', async () => {
    await boot({ freeSeconds: 60 });
    const id = (await declare()).body.job.id as string;
    const put = await fetch(`${base}/v1/audio/jobs/${id}/content`, { method: 'PUT', body: new Uint8Array([1, 2, 3, 4]) });
    expect(put.status).toBe(204);
    await http('POST', `/v1/audio/jobs/${id}/uploaded`, {});

    const worker = { authorization: `Bearer ${WORKER}` };
    const claimed = (await http('POST', '/v1/worker/audio/claim', {}, worker)).body.job;
    await http('POST', `/v1/worker/audio/jobs/${id}/complete`, { leaseToken: claimed.leaseToken, durationSeconds: 60, result: { inline: JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'note-events', 'valid_silent_voice.json'), 'utf8')) } }, worker);

    expect((await http('GET', '/v1/audio/usage')).body.usage).toMatchObject({ seconds: 60, capSeconds: 60 });
    expect((await declare(1)).status).toBe(403);
  });

  it('does not touch a user the configuration lists as unlimited, and honours a larger allowance', async () => {
    await boot({ freeSeconds: 10, plans: { local: 'unlimited' } });
    for (let i = 0; i < 3; i += 1) expect((await declare(500)).status).toBe(201);
    expect((await http('GET', '/v1/audio/usage')).body.usage.capSeconds).toBeNull();
    await api!.close();

    await boot({ freeSeconds: 10, plans: { local: 3600 } });
    expect((await declare(3000)).status).toBe(201);
    expect((await declare(700)).status).toBe(201);
    expect((await declare(1)).status).toBe(403); // 3700 reserved against 3600
  });

  it('applies no cap when none is configured, and deleting what is waiting frees its reservation', async () => {
    await boot({ freeSeconds: null });
    for (let i = 0; i < 3; i += 1) expect((await declare(100_000)).status).toBe(201);
    await api!.close();

    await boot({ freeSeconds: 60 });
    const id = (await declare(60)).body.job.id as string;
    expect((await declare(1)).status).toBe(403);
    await http('DELETE', `/v1/audio/jobs/${id}`);
    expect((await declare(1)).status).toBe(201);
  });
});
