import { describe, expect, it } from 'vitest';
import { WorkerError, createJobBus, createJobRunner, memoryBlobStore, memoryJobStore } from '@sibei/api';
import type { ImportJob, JobChanged, JobStore } from '@sibei/api';

/**
 * A `wake()` is never lost (V18, ADR-0034).
 *
 * While the job store was synchronous the runner's drain loop could not be interrupted between "ask
 * the store for work" and "stand down", so a submit's `wake()` was always either seen by the running
 * drain or started a fresh one. With an asynchronous store that window exists: a submit can commit a
 * job and call `wake()` *after* `claim()` has already looked and found nothing but *before* the loop
 * has stood down. Without care the wake is dropped (a drain is "already running"), the job sits
 * `queued`, and nothing ever runs it. The runner records the request and looks once more.
 *
 * The store here reproduces that window exactly: `claim` decides "nothing waiting" first and only
 * then yields, so it is guaranteed to answer from *before* the submit.
 */

const OWNER = 'local';

function slowClaimStore(): { jobs: JobStore; releaseFirstClaim: () => void; firstClaimStarted: Promise<void> } {
  const inner = memoryJobStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const firstClaimStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let first = true;
  const jobs: JobStore = {
    ...inner,
    async claim(): Promise<ImportJob | null> {
      const answer = await inner.claim(); // decided now: the queue is empty
      if (first) {
        first = false;
        started();
        await gate; // ...and only then does the answer travel back
      }
      return answer;
    },
  };
  return { jobs, releaseFirstClaim: release, firstClaimStarted };
}

describe('the job runner never loses a wake', () => {
  it('runs a job committed while the drain was mid-claim, with no further wake', async () => {
    const { jobs, releaseFirstClaim, firstClaimStarted } = slowClaimStore();
    const blobs = memoryBlobStore();
    const bus = createJobBus();
    const runner = createJobRunner({
      jobs,
      blobs,
      // The job only has to be *picked up*; failing it is the cheapest way to see that it was.
      worker: { recognize: () => Promise.reject(new WorkerError('stub worker: not needed')) },
      importer: { import: () => Promise.reject(new Error('unreachable')) },
      publisher: bus,
    });

    runner.wake(); // a drain begins, and its first claim finds nothing
    await firstClaimStarted;

    // The submit: the blob and the job land, then the route wakes the runner — all while the first
    // drain's claim is still in flight and `draining` is true.
    await blobs.put('img-0', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(25).fill(0)]));
    const job = await jobs.create(OWNER, ['img-0']);
    const settled = new Promise<JobChanged>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the job was never picked up — the wake was lost')), 1500);
      bus.subscribe(OWNER, job.id, (event) => {
        if (event.status === 'succeeded' || event.status === 'failed') {
          clearTimeout(timer);
          resolve(event);
        }
      });
    });
    runner.wake();

    releaseFirstClaim(); // the stale "nothing waiting" answer now returns
    const event = await settled;

    expect(event.status).toBe('failed'); // picked up and run (the stub worker refuses it)
    expect((await jobs.get(OWNER, job.id))?.attempts).toBe(1);
    runner.stop();
  });
});
