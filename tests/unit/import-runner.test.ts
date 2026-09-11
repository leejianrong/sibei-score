import { describe, expect, it } from 'vitest';
import {
  WorkerError,
  createJobBus,
  createJobRunner,
  memoryBlobStore,
  memoryJobStore,
} from '@sibei/api';
import type { BlobStore, JobBus, JobChanged, JobStore, ScoreImporter, WorkerClient } from '@sibei/api';
import { OMR_SCHEMA_VERSION } from '@sibei/model';
import type { OmrDocument } from '@sibei/model';

/**
 * The job runner (V10): the "run" in ADR-0001's "submit, then poll or subscribe". These are the unit
 * clauses of the V10 test plan — job state transitions including retry after failure — plus the Q80
 * property that a failed import records a diagnostic, is retryable, and commits nothing.
 *
 * Fast-layer: memory stores and a stub worker, no oemer and no socket. The worker returning an
 * {@link OmrDocument} is exactly what the real one does across the HTTP boundary; substituting it
 * here is the whole point of the port (ADR-0005).
 */

const OWNER = 'local';

/**
 * A recognised page with one staff and one note, so V11's mapper produces a real score (an empty
 * `staves` throws `OmrMappingError` — the "no staff" case is its own test below).
 */
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

/** A stub importer: records what it was asked to land and returns the document's own id as the score. */
function stubImporter(): ScoreImporter & { calls: Array<{ owner: string; id: string }> } {
  const calls: Array<{ owner: string; id: string }> = [];
  return {
    calls,
    import(owner, document) {
      calls.push({ owner, id: document.id });
      return { scoreId: document.id };
    },
  };
}

/** A one-pixel PNG, so the runner's format re-detection finds a real image in the blob. */
function pngBytes(): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(1, 8);
  ihdr.writeUInt32BE(1, 12);
  return Buffer.concat([sig, ihdr]);
}

interface Harness {
  jobs: JobStore;
  blobs: BlobStore;
  bus: JobBus;
  importer: ReturnType<typeof stubImporter>;
  runner: ReturnType<typeof createJobRunner>;
  submit(imageKeys?: string[]): Promise<{ id: string }>;
  terminal(id: string): Promise<JobChanged>;
}

async function harness(worker: WorkerClient): Promise<Harness> {
  const jobs = memoryJobStore();
  const blobs = memoryBlobStore();
  const bus = createJobBus();
  const importer = stubImporter();
  const runner = createJobRunner({ jobs, blobs, worker, importer, publisher: bus });

  const submit = async (imageKeys = ['img-0']): Promise<{ id: string }> => {
    for (const key of imageKeys) await blobs.put(key, pngBytes());
    const job = jobs.create(OWNER, imageKeys);
    return { id: job.id };
  };

  // Resolve when a job reaches a terminal status, so a test never races the background drain.
  const terminal = (id: string): Promise<JobChanged> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`job ${id} did not settle`)), 2000);
      const unsubscribe = bus.subscribe(OWNER, id, (event) => {
        if (event.status === 'succeeded' || event.status === 'failed') {
          clearTimeout(timer);
          unsubscribe();
          resolve(event);
        }
      });
    });

  return { jobs, blobs, bus, importer, runner, submit, terminal };
}

const okWorker = (doc = aDocument()): WorkerClient => ({ recognize: () => Promise.resolve(doc) });

describe('the import job runner', () => {
  it('runs a queued job to succeeded and stores the recognised objects', async () => {
    const doc = aDocument();
    const h = await harness(okWorker(doc));
    const { id } = await h.submit();

    h.runner.start();
    const event = await h.terminal(id);
    expect(event.status).toBe('succeeded');

    const job = h.jobs.get(OWNER, id);
    expect(job?.status).toBe('succeeded');
    expect(job?.attempts).toBe(1);
    expect(job?.diagnostic).toBeNull();
    expect(job?.result).toEqual([doc]);
    // V11 maps the objects and lands a score through the applier's import path, then records its id.
    expect(job?.scoreId).toBe(`import-${id}`);
    expect(h.importer.calls).toEqual([{ owner: OWNER, id: `import-${id}` }]);
  });

  it('fails cleanly when no staff is detected, committing no score (ADR-0018, Q28)', async () => {
    const h = await harness(okWorker(noStaffDocument()));
    const { id } = await h.submit();

    h.runner.start();
    expect((await h.terminal(id)).status).toBe('failed');

    const job = h.jobs.get(OWNER, id);
    expect(job?.status).toBe('failed');
    expect(job?.diagnostic).toContain('no staff');
    // The mapper threw before the importer was reached: no score, and nothing to undo.
    expect(job?.scoreId).toBeNull();
    expect(h.importer.calls).toEqual([]);
  });

  it('records a diagnostic and commits nothing when the worker fails (Q80)', async () => {
    const worker: WorkerClient = {
      recognize: () => Promise.reject(new WorkerError('could not reach the OMR worker')),
    };
    const h = await harness(worker);
    const { id } = await h.submit();

    h.runner.start();
    const event = await h.terminal(id);
    expect(event.status).toBe('failed');

    const job = h.jobs.get(OWNER, id);
    expect(job?.status).toBe('failed');
    expect(job?.diagnostic).toContain('could not reach the OMR worker');
    // Commits nothing: no result, no score.
    expect(job?.result).toBeNull();
    expect(job?.scoreId).toBeNull();
  });

  it('retries a failed job, and the retry succeeds (state transitions incl. retry)', async () => {
    let attempt = 0;
    const worker: WorkerClient = {
      recognize: () => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(new WorkerError('worker down'))
          : Promise.resolve(aDocument());
      },
    };
    const h = await harness(worker);
    const { id } = await h.submit();

    h.runner.start();
    expect((await h.terminal(id)).status).toBe('failed');

    // Retry is a user action: requeue, then wake the runner — the ImportService pairs these.
    const requeued = h.jobs.retry(OWNER, id);
    expect(requeued?.status).toBe('queued');
    const settled = h.terminal(id);
    h.runner.wake();

    expect((await settled).status).toBe('succeeded');
    const job = h.jobs.get(OWNER, id);
    expect(job?.status).toBe('succeeded');
    expect(job?.attempts).toBe(2); // two runs: the failure and the successful retry.
  });

  it('fails a job whose source image is missing from the blob store', async () => {
    const h = await harness(okWorker());
    // Create a job pointing at a key we never `put` — a corrupted store, still this job's failure.
    const job = h.jobs.create(OWNER, ['absent-key']);

    h.runner.start();
    expect((await h.terminal(job.id)).status).toBe('failed');
    expect(h.jobs.get(OWNER, job.id)?.diagnostic).toContain('missing from the blob store');
  });

  it('drains several queued jobs one after another', async () => {
    const h = await harness(okWorker());
    const a = await h.submit(['a-0']);
    const b = await h.submit(['b-0']);

    const both = Promise.all([h.terminal(a.id), h.terminal(b.id)]);
    h.runner.start();
    const [ea, eb] = await both;
    expect(ea.status).toBe('succeeded');
    expect(eb.status).toBe('succeeded');
  });

  it('recovers a job left running by a previous process into a retryable failure (ADR-0001 #7)', async () => {
    const h = await harness(okWorker());
    // Simulate a crash mid-run: a job the store still thinks is running.
    const job = h.jobs.create(OWNER, ['img-0']);
    const claimed = h.jobs.claim();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe('running');

    // A fresh runner starts and recovers it.
    const runner = createJobRunner({
      jobs: h.jobs,
      blobs: h.blobs,
      worker: okWorker(),
      importer: stubImporter(),
      publisher: h.bus,
    });
    runner.start();

    const recovered = h.jobs.get(OWNER, job.id);
    expect(recovered?.status).toBe('failed');
    expect(recovered?.diagnostic).toContain('server stopped before this import finished');
  });
});
