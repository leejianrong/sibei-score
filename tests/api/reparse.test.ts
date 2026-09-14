import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, silentLogger } from '@sibei/api';
import type { Api, JobStore, ScoreStore, WorkerClient } from '@sibei/api';
import { openSqliteJobStore, openSqliteStore } from '@sibei/api/sqlite';
import { OMR_SCHEMA_VERSION } from '@sibei/model';
import type { OmrDocument } from '@sibei/model';

/**
 * Re-parse (V14e, ADR-0019): re-run OMR on an imported chart's *retained* source images into a NEW
 * draft, with no new upload. These exercise the API's `POST /v1/scores/:id/reparse` end to end over
 * real HTTP with a stub worker (ADR-0005): it must reuse the original job's blob keys (not re-upload),
 * create a fresh job and a fresh score through the same runner → `Applier.import` seam a normal import
 * takes (never a second write path, ADR-0003), record and thread the chosen engine, and refuse cleanly
 * when there is no scan behind the score, when the engine is unknown, and when there is no worker.
 */

const A_PNG = pngBytes(1612, 2280);

function pngBytes(width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  return Buffer.concat([sig, ihdr]);
}

/** A recognised page with one staff and one note, so the V11 mapper produces a real score. */
function aDocument(imagePath = 'page-1'): OmrDocument {
  return {
    schemaVersion: OMR_SCHEMA_VERSION,
    source: {
      engine: 'oemer',
      engineVersion: '0.1.8',
      imagePath,
      imageWidth: 1612,
      imageHeight: 2280,
      provider: 'CPUExecutionProvider',
      wallClockSeconds: 321,
    },
    staves: [
      { index: 0, track: 0, group: 0, xLeft: 100, xRight: 1000, yUpper: 100, yLower: 164, yCenter: 132, unitSize: 16 },
    ],
    zones: [],
    noteheads: [
      {
        id: 0,
        bbox: [291, 120, 309, 136],
        track: 0,
        group: 0,
        noteGroupId: null,
        staffLinePos: null,
        pitch: null,
        hasDot: false,
        stemUp: true,
        invalid: false,
        label: 'QUARTER',
      },
    ],
    noteGroups: [],
    barlines: [],
    rests: [],
    bandTokens: [],
  };
}

let store: ScoreStore;
let jobs: JobStore;
let api: Api;
let base: string;
/** The stub worker's behaviour, swappable per test. Defaults to returning a document at once. */
let behave: () => Promise<OmrDocument>;
/** The engine name the last worker call was asked for, so a test can assert the thread-through. */
let lastEngine: string | undefined;

const worker: WorkerClient = {
  recognize: (_image, meta) => {
    lastEngine = meta.engine;
    return behave();
  },
};

async function boot(options: { withWorker: boolean } = { withWorker: true }): Promise<void> {
  store = openSqliteStore({ filename: ':memory:' });
  jobs = openSqliteJobStore({ filename: ':memory:' });
  api = createApi({
    store,
    jobs,
    logger: silentLogger,
    ...(options.withWorker ? { worker } : {}),
  });
  const { port } = await api.listen(0);
  base = `http://127.0.0.1:${port}`;
}

beforeEach(() => {
  behave = () => Promise.resolve(aDocument());
  lastEngine = undefined;
});

afterEach(async () => {
  await api.close();
  jobs.close();
  store.close();
});

interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

async function upload(bytes: Buffer, contentType = 'image/png'): Promise<Reply> {
  const response = await fetch(`${base}/v1/imports`, {
    method: 'POST',
    body: new Uint8Array(bytes),
    headers: { 'content-type': contentType },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : JSON.parse(text), headers: response.headers };
}

async function get(path: string): Promise<Reply> {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : JSON.parse(text), headers: response.headers };
}

async function post(path: string, body?: unknown): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : JSON.parse(text), headers: response.headers };
}

/** Poll a job to a terminal status. The stub worker settles fast, so this rarely loops. */
async function settle(id: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const { body } = await get(`/v1/imports/${id}`);
    const job = body.job as Record<string, unknown>;
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`import ${id} did not settle`);
}

/** Import one image and return the succeeded job (its id, imageKeys, and the scoreId it produced). */
async function importOnce(): Promise<{ jobId: string; imageKeys: string[]; scoreId: string }> {
  const created = await upload(A_PNG);
  const job = created.body.job as Record<string, unknown>;
  const done = await settle(job.id as string);
  return { jobId: job.id as string, imageKeys: done.imageKeys as string[], scoreId: done.scoreId as string };
}

describe('POST /v1/scores/:id/reparse (V14e)', () => {
  beforeEach(() => boot());

  it('creates a NEW job and a NEW score from the existing image keys, with no re-upload', async () => {
    const first = await importOnce();

    const reply = await post(`/v1/scores/${first.scoreId}/reparse`);
    expect(reply.status).toBe(202);
    const newJob = reply.body.job as Record<string, unknown>;
    // A fresh job, pointing at the SAME retained scans — reparse reuses the blob keys, never re-uploads.
    expect(newJob.id).not.toBe(first.jobId);
    expect(newJob.imageKeys).toEqual(first.imageKeys);
    expect(reply.headers.get('location')).toBe(`/v1/imports/${newJob.id}`);

    const done = await settle(newJob.id as string);
    expect(done.status).toBe('succeeded');
    // A NEW draft, not an in-place replacement — the original score is untouched and still openable.
    expect(done.scoreId).not.toBe(first.scoreId);
    expect((await get(`/v1/scores/${first.scoreId}`)).status).toBe(200);
    const opened = await get(`/v1/scores/${done.scoreId as string}`);
    expect(opened.status).toBe(200);
    expect((opened.body.score as { bars: unknown[] }).bars.length).toBeGreaterThan(0);
  });

  it('records the chosen engine on the new job and threads it to the worker', async () => {
    const first = await importOnce();
    // The original import recorded no engine (worker default).
    expect((await get(`/v1/imports/${first.jobId}`)).body.job).toMatchObject({ engine: null });

    const reply = await post(`/v1/scores/${first.scoreId}/reparse`, { engine: 'heuristic' });
    expect(reply.status).toBe(202);
    const newJob = reply.body.job as Record<string, unknown>;
    expect(newJob.engine).toBe('heuristic');

    await settle(newJob.id as string);
    // The runner passed the recorded engine to the worker client for the actual recognition.
    expect(lastEngine).toBe('heuristic');
  });

  it('leaves the engine to the worker default when none is chosen', async () => {
    const first = await importOnce();
    const reply = await post(`/v1/scores/${first.scoreId}/reparse`);
    const newJob = reply.body.job as Record<string, unknown>;
    expect(newJob.engine).toBeNull();
    await settle(newJob.id as string);
    expect(lastEngine).toBeUndefined();
  });

  it('goes through the same runner → Applier.import seam (the new score has a single-op history)', async () => {
    // A reparse-produced score is landed by score.import exactly like an import: undoing it leaves an
    // empty score (nothing before the import), proving it is not a second write path (ADR-0003).
    const first = await importOnce();
    const reply = await post(`/v1/scores/${first.scoreId}/reparse`);
    const done = await settle((reply.body.job as Record<string, unknown>).id as string);
    const newId = done.scoreId as string;

    const read = await get(`/v1/scores/${newId}`);
    const version = (read.body as { version: number }).version;
    const undone = await post(`/v1/scores/${newId}/undo`, { expectedVersion: version });
    expect(undone.status).toBe(200);
    // The floor is the import op itself: undoing it is a clean no-op (there is nothing before it).
    expect((undone.body as { moved: boolean }).moved).toBe(false);
  });

  it('rejects an unknown engine with a 422 listing the ones it knows', async () => {
    const first = await importOnce();
    const reply = await post(`/v1/scores/${first.scoreId}/reparse`, { engine: 'wishful' });
    expect(reply.status).toBe(422);
    expect(reply.body.error).toMatchObject({ kind: 'unsupported-engine' });
    // The valid choices travel in the body so a client branches on data, not prose (ADR-0008).
    expect(((reply.body.error as { detail: { supported: string[] } }).detail.supported)).toContain('oemer');
  });

  it('returns a clean 422 (not a 500) for a hand-authored score with no scan to re-parse', async () => {
    const created = await post('/v1/scores', {
      operation: { type: 'score.create', payload: { id: 'hand', title: 'By Hand', bars: [{ id: 'b1', number: 1 }] } },
    });
    expect(created.status).toBe(201);
    const reply = await post('/v1/scores/hand/reparse');
    expect(reply.status).toBe(422);
    expect(reply.body.error).toMatchObject({ kind: 'no-source-to-reparse' });
  });

  it('returns the same no-source error for a score that does not exist', async () => {
    const reply = await post('/v1/scores/nope/reparse');
    expect(reply.status).toBe(422);
    expect(reply.body.error).toMatchObject({ kind: 'no-source-to-reparse' });
  });

  it("does not re-parse another owner's imported score", async () => {
    const scopedStore = openSqliteStore({ filename: ':memory:' });
    const scopedJobs = openSqliteJobStore({ filename: ':memory:' });
    const scopedApi = createApi({
      store: scopedStore,
      jobs: scopedJobs,
      worker,
      logger: silentLogger,
      authenticate: (request) => ({ owner: request.headers['x-owner'] === 'b' ? 'owner-b' : 'owner-a' }),
    });
    const { port } = await scopedApi.listen(0);
    const url = `http://127.0.0.1:${port}`;
    try {
      // owner-a imports (no x-owner header).
      const created = await fetch(`${url}/v1/imports`, {
        method: 'POST',
        body: new Uint8Array(A_PNG),
        headers: { 'content-type': 'image/png' },
      });
      const id = ((await created.json()) as { job: { id: string } }).job.id;
      let scoreId: string | null = null;
      for (let i = 0; i < 200 && scoreId === null; i++) {
        const polled = await fetch(`${url}/v1/imports/${id}`);
        const job = ((await polled.json()) as { job: { status: string; scoreId: string | null } }).job;
        if (job.status === 'succeeded') scoreId = job.scoreId;
        else if (job.status === 'failed') throw new Error('the import failed unexpectedly');
        else await new Promise((r) => setTimeout(r, 10));
      }
      // owner-b cannot reach owner-a's score, so there is no source for them to re-parse: a clean 422,
      // never owner-a's scans re-run under owner-b.
      const reply = await fetch(`${url}/v1/scores/${scoreId}/reparse`, {
        method: 'POST',
        headers: { 'x-owner': 'b' },
      });
      expect(reply.status).toBe(422);
      expect(((await reply.json()) as { error: { kind: string } }).error.kind).toBe('no-source-to-reparse');
    } finally {
      await scopedApi.close();
      scopedJobs.close();
      scopedStore.close();
    }
  });
});

describe('POST /v1/scores/:id/reparse without a worker (Q80)', () => {
  beforeEach(() => boot({ withWorker: false }));

  it('answers 503, not a crash — reparse needs a worker to run', async () => {
    const created = await post('/v1/scores', {
      operation: { type: 'score.create', payload: { id: 's1', title: 'X', bars: [{ id: 'b1', number: 1 }] } },
    });
    expect(created.status).toBe(201);
    const reply = await post('/v1/scores/s1/reparse');
    expect(reply.status).toBe(503);
    expect(reply.body.error).toMatchObject({ kind: 'worker-unavailable' });
  });
});
