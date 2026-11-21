import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, silentLogger } from '@sibei/api';
import type { Api, JobStore, ScoreStore, WorkerClient } from '@sibei/api';
import { openSqliteJobStore, openSqliteStore } from '@sibei/api/sqlite';
import { EXIT, exitCodeForKind } from '@sibei/cli';

/**
 * Photo import switched off (SIB2-201). A hosted service before photo import ships answers an image with a
 * clear, non-retryable error even if a worker were wired, and a NoteEvents file still lands.
 */

const fixture = readFileSync(join(__dirname, '..', 'fixtures', 'note-events', 'voice-ode-beats.json'), 'utf8');
const A_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('0000000d49484452', 'hex'),
  Buffer.from('0000064c000008e8', 'hex'),
  Buffer.alloc(9),
]);
const worker: WorkerClient = { recognize: () => Promise.reject(new Error('must never be called')) };

let store: ScoreStore;
let jobs: JobStore;
let api: Api;
let base: string;

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  jobs = openSqliteJobStore({ filename: ':memory:' });
  api = createApi({ store, jobs, worker, photoImport: false, logger: silentLogger });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
});

afterEach(async () => {
  await api.close();
  await jobs.close();
  await store.close();
});

describe('photo import off', () => {
  it('refuses an image with a 422 photo-import-unavailable, which is not retryable', async () => {
    const reply = await fetch(`${base}/v1/imports`, { method: 'POST', body: A_PNG, headers: { 'content-type': 'image/png' } });
    expect(reply.status).toBe(422);
    const body = (await reply.json()) as any;
    expect(body.error.kind).toBe('photo-import-unavailable');
    expect(body.error.message).toMatch(/not available on this service yet/);
    expect(exitCodeForKind(body.error.kind)).toBe(EXIT.validation);
  });

  it('refuses a re-parse the same way', async () => {
    const reply = await fetch(`${base}/v1/scores/x/reparse`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(reply.status).toBe(422);
    expect(((await reply.json()) as any).error.kind).toBe('photo-import-unavailable');
  });

  it('still lands a NoteEvents file', async () => {
    const reply = await fetch(`${base}/v1/imports`, { method: 'POST', body: fixture, headers: { 'content-type': 'application/json' } });
    expect(reply.status).toBe(202);
  });

  it('says so on /v1/me', async () => {
    expect(await (await fetch(`${base}/v1/me`)).json()).toEqual({ mode: 'local', photoImport: false });
  });
});
