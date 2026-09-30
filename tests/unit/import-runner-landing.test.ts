import { describe, expect, it } from 'vitest';
import { OperationError, createJobBus, createJobRunner, memoryBlobStore, memoryJobStore } from '@sibei/api';
import type { JobChanged, JobStore, ScoreImporter } from '@sibei/api';
import type { OmrDocument } from '@sibei/model';
import { aDocument, pngBytes } from './omr-support.js';

/**
 * Landing an import is idempotent (V19, ADR-0034).
 *
 * The runner lands the mapped score, then completes the job: two store writes with an `await` between
 * them. A process killed in between leaves a score and a job that never succeeded; startup `recover`
 * fails that job, and a retry mints the *same* score id (`import-<jobId>`, unique per owner). Before V19
 * that retry hit `already-exists` and failed forever. Now the runner recognises the clash as its own
 * earlier landing and completes the job against the score that is already there.
 */

const OWNER = 'local';

/** An importer that lands the first time and answers `conflict-exists` for that id ever after. */
function landsOnce(): ScoreImporter & { calls: string[] } {
  const landed = new Set<string>();
  const calls: string[] = [];
  return {
    calls,
    import(_owner, document) {
      calls.push(document.id);
      if (landed.has(document.id)) return Promise.reject(new OperationError({ kind: 'conflict-exists', id: document.id }));
      landed.add(document.id);
      return Promise.resolve({ scoreId: document.id });
    },
  };
}

async function setup(importer: ScoreImporter, wrap?: (jobs: JobStore) => JobStore) {
  const inner = memoryJobStore();
  const jobs = wrap === undefined ? inner : wrap(inner);
  const blobs = memoryBlobStore();
  const bus = createJobBus();
  const runner = createJobRunner({
    jobs,
    blobs,
    worker: { recognize: (): Promise<OmrDocument> => Promise.resolve(aDocument()) },
    importer,
    publisher: bus,
  });
  await blobs.put('img-0', pngBytes());
  const job = await inner.create(OWNER, ['img-0']);

  const settle = (): Promise<JobChanged> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the job did not settle')), 2000);
      const unsubscribe = bus.subscribe(OWNER, job.id, (event) => {
        if (event.status === 'succeeded' || event.status === 'failed') {
          clearTimeout(timer);
          unsubscribe();
          resolve(event);
        }
      });
    });
  return { jobs: inner, runner, job, settle };
}

describe('landing an import is idempotent', () => {
  it('treats "already there" for its own id as success and completes the job', async () => {
    const importer = landsOnce();
    const { jobs, runner, job, settle } = await setup(importer);
    // The score is already there from an earlier, interrupted attempt of this very job.
    await importer.import(OWNER, { ...aDocument(), id: `import-${job.id}` } as never);

    const settled = settle();
    await runner.start();
    expect((await settled).status).toBe('succeeded');
    expect(await jobs.get(OWNER, job.id)).toMatchObject({ status: 'succeeded', scoreId: `import-${job.id}` });
    runner.stop();
  });

  it('survives the crash window end to end: land, fail to complete, retry, succeed', async () => {
    const importer = landsOnce();
    let failNextComplete = true;
    const { jobs, runner, job, settle } = await setup(importer, (inner) => ({
      ...inner,
      async complete(id, result, scoreId) {
        if (failNextComplete) {
          // The process dies here: the score has landed, the job has not been told.
          failNextComplete = false;
          throw new Error('simulated crash between landing and completing');
        }
        return inner.complete(id, result, scoreId);
      },
    }));

    const first = settle();
    await runner.start();
    expect((await first).status).toBe('failed'); // what startup `recover` would have made of it
    expect(importer.calls).toEqual([`import-${job.id}`]);

    // The user retries. The runner re-recognises and mints the same score id, which is already there.
    await jobs.retry(OWNER, job.id);
    const second = settle();
    runner.wake();
    expect((await second).status).toBe('succeeded');
    expect(importer.calls).toEqual([`import-${job.id}`, `import-${job.id}`]);
    expect(await jobs.get(OWNER, job.id)).toMatchObject({ status: 'succeeded', scoreId: `import-${job.id}`, attempts: 2 });
    runner.stop();
  });

  it('does not swallow a clash on some *other* id', async () => {
    // Only this job's own id is evidence of an earlier landing. A clash on anything else is a real
    // conflict and must fail the job rather than be papered over.
    const { jobs, runner, job, settle } = await setup({
      import: () => Promise.reject(new OperationError({ kind: 'conflict-exists', id: 'someone-elses-score' })),
    });
    const settled = settle();
    await runner.start();
    expect((await settled).status).toBe('failed');
    expect((await jobs.get(OWNER, job.id))?.diagnostic).toMatch(/someone-elses-score/);
    runner.stop();
  });

  it('still fails the job on any other error', async () => {
    const { jobs, runner, job, settle } = await setup({ import: () => Promise.reject(new Error('the store is on fire')) });
    const settled = settle();
    await runner.start();
    expect((await settled).status).toBe('failed');
    expect((await jobs.get(OWNER, job.id))?.diagnostic).toBe('the store is on fire');
    runner.stop();
  });
});
