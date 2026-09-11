import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApi, silentLogger } from '@sibei/api';
import type { Api, JobStore, ScoreStore, WorkerClient } from '@sibei/api';
import { openSqliteJobStore, openSqliteStore } from '@sibei/api/sqlite';
import { OMR_SCHEMA_VERSION } from '@sibei/model';
import type { OmrDocument } from '@sibei/model';

/**
 * The OMR import pipeline over real HTTP (V10). The worker is a stub injected through the port
 * (ADR-0005) — the real one needs weights and minutes (V9), and its HTTP adapter is unit-tested
 * separately — so these exercise the *API's* job: accept an upload at the boundary (ADR-0029),
 * record and run a job (ADR-0001), report progress, and stay fully functional when the worker is
 * absent or failing (Q80).
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

/** A recognised page with one staff and one note, so V11's mapper produces a real score. */
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
  };
}

/** A page with no staff at all — ADR-0018's one hard error (Q28). */
function noStaffDocument(): OmrDocument {
  return { ...aDocument(), staves: [], noteheads: [] };
}

let store: ScoreStore;
let jobs: JobStore;
let api: Api;
let base: string;
/** The stub worker's behaviour, swappable per test. Defaults to returning a document at once. */
let behave: () => Promise<OmrDocument>;

const worker: WorkerClient = { recognize: () => behave() };

async function boot(options: { withWorker: boolean }): Promise<void> {
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

/** POST raw image bytes, the way the import verb will. */
async function upload(bytes: Buffer, contentType = 'image/png'): Promise<Reply> {
  const response = await fetch(`${base}/v1/imports`, {
    method: 'POST',
    body: new Uint8Array(bytes),
    headers: { 'content-type': contentType },
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : JSON.parse(text), headers: response.headers };
}

/** POST several images as multipart/form-data, the way the CLI and the browser picker do (Q26). */
async function uploadMany(images: Buffer[]): Promise<Reply> {
  const form = new FormData();
  for (const [i, image] of images.entries()) {
    form.append('images', new Blob([new Uint8Array(image)], { type: 'image/png' }), `page-${i + 1}.png`);
  }
  const response = await fetch(`${base}/v1/imports`, { method: 'POST', body: form });
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

describe('POST /v1/imports (the upload boundary, ADR-0029)', () => {
  beforeEach(() => boot({ withWorker: true }));

  it('accepts a valid image, enqueues a job, and runs it to succeeded', async () => {
    const created = await upload(A_PNG);
    expect(created.status).toBe(202);
    const job = created.body.job as Record<string, unknown>;
    expect(job.status === 'queued' || job.status === 'running').toBe(true);
    expect(created.headers.get('location')).toBe(`/v1/imports/${job.id}`);

    const done = await settle(job.id as string);
    expect(done.status).toBe('succeeded');
    // The raw recognised objects are still stored on the job (kept for re-parse / provenance).
    expect((done.result as OmrDocument[])[0]!.source.engine).toBe('oemer');
    // V11 maps them onto a score, lands it through score.import, and records its id on the job.
    expect(done.scoreId).toBe(`import-${job.id}`);
    // The score is a real, openable chart: it round-trips through the score API.
    const opened = await get(`/v1/scores/${done.scoreId as string}`);
    expect(opened.status).toBe(200);
    expect((opened.body.score as { bars: unknown[] }).bars.length).toBeGreaterThan(0);
  });

  it('imports several pages in one job as one chart (Q26)', async () => {
    const created = await uploadMany([A_PNG, A_PNG]);
    expect(created.status).toBe(202);
    const job = created.body.job as Record<string, unknown>;
    expect((job.imageKeys as string[]).length).toBe(2);

    const done = await settle(job.id as string);
    expect(done.status).toBe('succeeded');
    expect((done.result as OmrDocument[]).length).toBe(2);
    const opened = await get(`/v1/scores/${done.scoreId as string}`);
    // Two pages of one bar each -> two bars, numbered straight through.
    expect((opened.body.score as { bars: { number: number }[] }).bars.map((b) => b.number)).toEqual([1, 2]);
  });

  it('fails an import with no detectable staff, creating no score (ADR-0018, Q28)', async () => {
    behave = () => Promise.resolve(noStaffDocument());
    const created = await upload(A_PNG);
    const job = created.body.job as Record<string, unknown>;
    const done = await settle(job.id as string);
    expect(done.status).toBe('failed');
    expect(done.diagnostic).toContain('no staff');
    expect(done.scoreId).toBeNull();
  });

  it('rejects a non-image at the boundary rather than inside the worker', async () => {
    const reply = await upload(Buffer.from('%PDF-1.7 not an image'), 'image/png');
    expect(reply.status).toBe(422);
    expect(reply.body.error).toMatchObject({ kind: 'bad-upload-unsupported-format' });
  });

  it('detects the format from content, not the declared Content-Type', async () => {
    // Declares image/png, is actually garbage — refused, because detection reads the bytes.
    const reply = await upload(Buffer.from([0x00, 0x01, 0x02, 0x03]), 'image/png');
    expect(reply.status).toBe(422);
  });

  it('rejects a zero-byte upload', async () => {
    const reply = await upload(Buffer.alloc(0));
    expect(reply.status).toBe(422);
    expect(reply.body.error).toMatchObject({ kind: 'bad-upload-empty' });
  });

  it('rejects a dimension bomb', async () => {
    const reply = await upload(pngBytes(100_000, 100_000));
    expect(reply.status).toBe(422);
    expect(reply.body.error).toMatchObject({ kind: 'bad-upload-dimensions-too-large' });
  });
});

describe('job progress (ADR-0001: subscribe)', () => {
  beforeEach(() => boot({ withWorker: true }));

  it('streams status transitions over SSE, ending at succeeded', async () => {
    // Hold the worker on a gate so the stream is opened while the job is still running.
    let release!: () => void;
    behave = () =>
      new Promise<OmrDocument>((resolve) => {
        release = () => resolve(aDocument());
      });

    const created = await upload(A_PNG);
    const id = (created.body.job as Record<string, unknown>).id as string;

    const controller = new AbortController();
    const seen: string[] = [];
    const reading = (async () => {
      const response = await fetch(`${base}/v1/imports/${id}/events`, { signal: controller.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          for (const match of buffer.matchAll(/data: (\{[^\n]*\})/g)) {
            seen.push((JSON.parse(match[1]!) as { status: string }).status);
          }
          if (seen.includes('succeeded')) break;
        }
      } catch {
        // aborted — fine.
      }
    })();

    // Give the stream a moment to open and catch up, then let the worker finish.
    await new Promise((r) => setTimeout(r, 50));
    release();
    await reading;
    controller.abort();

    expect(seen).toContain('succeeded');
  });
});

describe('retry (Q80)', () => {
  beforeEach(() => boot({ withWorker: true }));

  it('fails a job when the worker errors, then a retry succeeds', async () => {
    let attempt = 0;
    behave = () => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error('worker exploded'))
        : Promise.resolve(aDocument());
    };

    const created = await upload(A_PNG);
    const id = (created.body.job as Record<string, unknown>).id as string;

    const failed = await settle(id);
    expect(failed.status).toBe('failed');
    expect(failed.diagnostic).toBeTruthy();
    expect(failed.result).toBeNull();

    const retried = await post(`/v1/imports/${id}/retry`);
    expect(retried.status).toBe(200);

    const done = await settle(id);
    expect(done.status).toBe('succeeded');
    expect(done.attempts).toBe(2);
  });

  it('refuses to retry a job that is not failed', async () => {
    const created = await upload(A_PNG);
    const id = (created.body.job as Record<string, unknown>).id as string;
    await settle(id); // now succeeded
    const reply = await post(`/v1/imports/${id}/retry`);
    expect(reply.status).toBe(409);
    expect(reply.body.error).toMatchObject({ kind: 'job-not-retryable' });
  });

  it('404s a retry of a job that does not exist', async () => {
    const reply = await post('/v1/imports/nope/retry');
    expect(reply.status).toBe(404);
  });
});

describe('the API without a worker (Q80: everything else still works)', () => {
  beforeEach(() => boot({ withWorker: false }));

  it('answers POST /v1/imports with 503, not a crash', async () => {
    const reply = await upload(A_PNG);
    expect(reply.status).toBe(503);
    expect(reply.body.error).toMatchObject({ kind: 'worker-unavailable' });
  });

  it('still lists imports (empty) and serves every non-import feature', async () => {
    // Listing and inspecting imports works without a worker — only submitting one needs it.
    const list = await get('/v1/imports');
    expect(list.status).toBe(200);
    expect(list.body.jobs).toEqual([]);
    // Health, and a full create/read round-trip, unaffected by the missing worker.
    expect((await get('/v1/health')).status).toBe(200);
    const created = await post('/v1/scores', {
      operation: { type: 'score.create', payload: { id: 's1', title: 'Blue', bars: [{ id: 'b1', number: 1 }] } },
    });
    expect(created.status).toBe(201);
    expect((await get('/v1/scores/s1')).status).toBe(200);
  });
});
