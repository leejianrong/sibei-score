import { OmrMappingError, mapOmrToScore } from '@sibei/model';
import type { Id, OmrDocument, Score } from '@sibei/model';
import type { BlobStore } from '../blob/blob-store.js';
import type { JobPublisher } from '../events/job-bus.js';
import type { ImportJob, JobWriter } from '../store/jobs.js';
import type { Owner } from '../store/repository.js';
import { imageFormatOf } from './upload.js';
import { WorkerError } from './worker-client.js';
import type { WorkerClient } from './worker-client.js';

/**
 * The one applier capability the runner is given: land a mapped document as a new score (V11). It is
 * deliberately this narrow — the runner holds no `ScoreWriter` and cannot reach the op applier's edit
 * surface, only its server-only import path (ADR-0003, ADR-0005). `createApi` builds it from the real
 * applier's `import`.
 */
export interface ScoreImporter {
  import(owner: Owner, document: Score): { scoreId: Id };
}

/**
 * The job runner: the in-process actor that turns queued import jobs into recognised objects, one at
 * a time. This is the "run" in ADR-0001's "submit, then poll or subscribe" — the API submits a job
 * and returns immediately, and this drains the queue in the background so a five-minute recognition
 * (ADR-0025) is a progress bar the user walks away from rather than a hung request.
 *
 * **It is not a second write path.** It holds a `JobWriter`, never a `ScoreWriter` — it moves a
 * job's status and stores the raw recognised objects, and nothing here touches a score (ADR-0003,
 * ADR-0005). Mapping those objects onto a `Score` and landing them through `score.import` is V11's
 * work; in V10 a succeeded job carries the objects and that is the whole of it (SLICES.md).
 *
 * **Concurrency is one, deliberately.** oemer's peak resident memory is ~7 GB and its wall-clock is
 * content-independent (V9), so two at once would double the memory for no throughput a single-user
 * local app can use. The drain loop claims and processes one job, then the next.
 *
 * **A failed job commits nothing and stays retryable** (Q80). The worker being unreachable, erroring,
 * or returning off-schema output all land as `WorkerError` at the `WorkerClient` boundary; the runner
 * writes the message as the job's diagnostic and moves on. There is never a half-written score,
 * because no score is written until the objects are complete and mapped (V11).
 */
export interface JobRunner {
  /**
   * Begin. Recovers any job left `running` by a previous process (ADR-0001 #7: state is durable, the
   * process is not) into a retryable `failed`, then drains whatever is queued. Called when the API
   * starts serving.
   */
  start(): void;
  /** Nudge the runner that a job may be waiting. Called after a submit; cheap and idempotent. */
  wake(): void;
  /**
   * Stop claiming new jobs. A job already in flight is abandoned — its worker call may still be
   * running, and it will be recovered on the next `start` — because `Api.close()` cannot wait five
   * minutes for a recognition to finish. Idempotent.
   */
  stop(): void;
}

export interface JobRunnerOptions {
  jobs: JobWriter;
  blobs: BlobStore;
  worker: WorkerClient;
  /** Lands the mapped document as a new score, the only write the runner can make (V11). */
  importer: ScoreImporter;
  publisher: JobPublisher;
  /** Where an unexpected runner failure is reported. Never re-thrown — it must not crash the API. */
  onError?: (message: string, error: unknown) => void;
}

/** The diagnostic a job left `running` across a restart is failed with. */
export const INTERRUPTED_DIAGNOSTIC =
  'the server stopped before this import finished; it was not completed — retry it';

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const { jobs, blobs, worker, importer, publisher } = options;
  const onError = options.onError ?? (() => {});

  let draining = false;
  let stopped = false;

  function wake(): void {
    if (draining || stopped) return;
    draining = true;
    // Not awaited: submitting a job returns immediately (ADR-0001). The loop runs to the end of the
    // queue on its own, and any failure inside it is caught per-job — this `.catch` is only for a
    // failure of the loop machinery itself (e.g. the job store is unreadable), which must be logged
    // rather than left an unhandled rejection.
    void drain()
      .catch((error: unknown) => onError('the import job runner loop failed', error))
      .finally(() => {
        draining = false;
      });
  }

  async function drain(): Promise<void> {
    // The path from `claim() === null` to the loop returning is synchronous — no `await` between —
    // so a submit's `wake()` cannot slip in after the last claim and be lost: it either finds the
    // loop still draining (and the loop will claim its job) or runs after `draining` is cleared.
    while (!stopped) {
      const job = jobs.claim();
      if (job === null) return;
      await process(job);
    }
  }

  async function process(job: ImportJob): Promise<void> {
    // `claim` already moved it to `running`; tell any subscriber who was watching it queue up.
    publisher.publish(job.owner, { jobId: job.id, status: 'running' });

    try {
      const results: OmrDocument[] = [];
      for (const [index, key] of job.imageKeys.entries()) {
        const bytes = await blobs.get(key);
        if (bytes === null) {
          throw new WorkerError(`source image ${index + 1} is missing from the blob store (key ${key})`);
        }
        const format = imageFormatOf(bytes);
        if (format === null) {
          // The upload boundary already proved this was an image; a blob that no longer decodes is a
          // corrupted store, not a user error — but it is still this job's failure, not the API's.
          throw new WorkerError(`source image ${index + 1} is no longer a decodable image`);
        }
        const doc = await worker.recognize(bytes, { imagePath: `page-${index + 1}`, format });
        results.push(doc);
      }

      // Map the recognised pages onto a Score and land it through the applier's server-only import
      // path (V11). Mapping and landing are synchronous and adjacent — no `await` between them — so
      // the job is completed in the same tick the score is created; there is never a succeeded job
      // with no score, nor a score with no succeeded job. A `mapOmrToScore` throw (no staff detected,
      // ADR-0018/Q28) or a store conflict fails the job, committing nothing (Q80), exactly like a
      // worker error — a failed import leaves no half-written score to undo (ADR-0003).
      const document = mapOmrToScore(results, { id: `import-${job.id}` });
      const { scoreId } = importer.import(job.owner, document);

      const done = jobs.complete(job.id, results, scoreId);
      if (done !== null) publisher.publish(done.owner, { jobId: done.id, status: 'succeeded' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = jobs.fail(job.id, message);
      if (failed !== null) publisher.publish(failed.owner, { jobId: failed.id, status: 'failed' });
      // Worker failure (Q80) and "no staff detected" (ADR-0018/Q28) are both expected outcomes,
      // recorded as a diagnostic, not surfaced as an API bug. Anything else is unexpected.
      if (!(error instanceof WorkerError) && !(error instanceof OmrMappingError)) {
        onError('an import job failed unexpectedly', error);
      }
    }
  }

  return {
    start() {
      stopped = false;
      // Orphaned running jobs first, before draining — otherwise the loop could claim a genuinely
      // queued job while a leftover running one sits mislabelled. Each is now a `failed` job with the
      // interrupted diagnostic, which is its own record; nothing is listening at boot to announce to.
      jobs.recover(INTERRUPTED_DIAGNOSTIC);
      wake();
    },
    wake,
    stop() {
      stopped = true;
    },
  };
}
