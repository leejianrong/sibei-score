import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, silentLogger } from '@sibei/api';
import type { Api, JobStore, ScoreStore } from '@sibei/api';
import { openSqliteJobStore, openSqliteStore } from '@sibei/api/sqlite';
import { projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';

/**
 * NoteEvents import over real HTTP (ADR-0040). No OMR worker is configured at all: a NoteEvents file
 * needs none, only the pure mapper, so it must work on a server that cannot import a photo.
 */

const fixture = (name: string): string => readFileSync(join(__dirname, '..', 'fixtures', 'note-events', name), 'utf8');

let store: ScoreStore;
let jobs: JobStore;
let api: Api;
let base: string;

beforeEach(async () => {
  store = openSqliteStore({ filename: ':memory:' });
  jobs = openSqliteJobStore({ filename: ':memory:' });
  api = createApi({ store, jobs, logger: silentLogger });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
});

afterEach(async () => {
  await api.close();
  await jobs.close();
  await store.close();
});

async function upload(body: string) {
  const response = await fetch(`${base}/v1/imports`, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function settle(id: string): Promise<Record<string, any>> {
  for (let i = 0; i < 200; i++) {
    const job = ((await (await fetch(`${base}/v1/imports/${id}`)).json()) as any).job;
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('did not settle');
}

async function scoreOf(id: string): Promise<Score> {
  return ((await (await fetch(`${base}/v1/scores/${id}`)).json()) as any).score;
}

describe('POST /v1/imports with a NoteEvents document (ADR-0040)', () => {
  it('imports to a draft with no worker, keeping the warnings on the job', async () => {
    const created = await upload(fixture('bass-walking-beats.json'));
    expect(created.status).toBe(202);
    const job = await settle(created.body.job.id);
    expect(job.status).toBe('succeeded');
    expect(job.diagnostic).toContain('low_confidence_region');
    const score = await scoreOf(job.scoreId);
    expect(score.bars).toHaveLength(4);
    expect(projectScore(score)).toContain('!41');
  });

  it('imports a silent document to an empty draft, not an error', async () => {
    const job = await settle((await upload(fixture('valid_silent_voice.json'))).body.job.id);
    expect(job.status).toBe('succeeded');
    expect(job.diagnostic).toContain('silent_input');
    expect((await scoreOf(job.scoreId)).bars[0]!.items).toEqual([]);
  });

  it('has no scan to show', async () => {
    const job = await settle((await upload(fixture('voice-ode-beats.json'))).body.job.id);
    const source = (await (await fetch(`${base}/v1/scores/${job.scoreId}/source`)).json()) as any;
    expect(source.imageCount).toBe(0);
  });

  it('refuses each bad file with its own non-retryable kind, and creates no job', async () => {
    const cases: Array<[string, string]> = [
      ['not json {', 'invalid-note-events'],
      [fixture('invalid_offset_not_after_onset.json'), 'invalid-note-events'],
      [fixture('invalid_unknown_major.json'), 'unsupported-note-events-version'],
      [fixture('drums-valid-unsupported.json'), 'unsupported-note-events-instrument'],
    ];
    for (const [body, kind] of cases) {
      const reply = await upload(body);
      expect(reply.status).toBe(422);
      expect(reply.body.error.kind).toBe(kind);
    }
    const listed = (await (await fetch(`${base}/v1/imports`)).json()) as any;
    expect(listed.jobs).toEqual([]);
  });

  it('still refuses an image with no worker (503)', async () => {
    const response = await fetch(`${base}/v1/imports`, { method: 'POST', body: new Uint8Array([1]), headers: { 'content-type': 'image/png' } });
    expect(response.status).toBe(503);
  });
});
