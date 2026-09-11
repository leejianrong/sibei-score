import type { Id } from '@sibei/model';
import type { OmrDocument } from '@sibei/model';
import type { BlobKey } from '../blob/blob-store.js';
import type { Owner } from './repository.js';

/**
 * The import-job store: the durable queue behind "OMR is a job, not a request" (ADR-0001).
 *
 * V10 is the plumbing slice — the worker in a job, offline, with the API fully functional when the
 * worker is stopped (SLICES.md V10). A job takes 1..n uploaded images (Q26), the runner hands them
 * to the Python worker (ADR-0005) one at a time, and the raw recognised objects come back as an
 * {@link OmrDocument} per image. **Mapping those objects onto a `Score` and landing them through the
 * server-only `score.import` op is V11's job, not this one** (SLICES.md V11 build plan). So in V10 a
 * succeeded job carries the recognised objects and `scoreId` stays `null`; the field exists now so
 * the importer can fill it without a schema change.
 *
 * **A port, in halves, for the reason the score store is** (ADR-0003, ADR-0006). `JobReader` is
 * reads and anything may hold one; the writes are split so a route handler cannot advance a job's
 * status — only the runner (`server.ts` hands the runner the writer and the routes the reader). And
 * as with the score store, this file names no database: SQLite is `sqlite-jobs.ts`'s secret and
 * nothing else's (ADR-0006), which is what keeps the hosted transition to a real queue a change of
 * adapter and not a rewrite (docs/hosting.md).
 */

/** A job's id, minted by the store (unlike a score's, which the client supplies). */
export type JobId = string;

/**
 * The lifecycle. A short, closed vocabulary because the wire names it and `/v1/` freezes after the
 * hosted transition (ADR-0022):
 *
 *   - `queued`    — accepted and waiting for the runner.
 *   - `running`   — the runner has claimed it and is calling the worker.
 *   - `succeeded` — the worker returned; `result` holds the recognised objects.
 *   - `failed`    — the worker was unreachable or errored; `diagnostic` says how, and it is
 *                   **retryable** (Q80). A failed import commits nothing (ADR-0003), so there is
 *                   never a half-written score to undo.
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/**
 * A job, in full. `result` is populated only on `succeeded`, `diagnostic` only on `failed`. The
 * result is one {@link OmrDocument} per source image, in the same order as `imageKeys` — a single
 * image is the V10 common case, an array because a chart may span several (Q26).
 */
export interface ImportJob {
  id: JobId;
  owner: Owner;
  status: JobStatus;
  /** BlobStore keys for the uploaded source images, in page order. Always ≥ 1. */
  imageKeys: BlobKey[];
  /** How many times the runner has started this job. 0 while `queued` and never run. */
  attempts: number;
  /** The failure reason when `failed`; `null` otherwise (Q80). */
  diagnostic: string | null;
  /** The raw recognised objects when `succeeded`; `null` otherwise. */
  result: OmrDocument[] | null;
  /** The score this import produced, once V11 maps and lands it. `null` in V10. */
  scoreId: Id | null;
  /** Optimistic-concurrency version — see the schema note. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A job without its (potentially large) `result`. What a listing returns, so drawing the list of
 * imports never deserialises every recognised document — the same reason the score listing omits
 * `doc` (ADR-0006).
 */
export type ImportJobSummary = Omit<ImportJob, 'result'>;

export interface JobReader {
  /** This owner's jobs, newest first, without their results. */
  list(owner: Owner): ImportJobSummary[];
  /** One job in full, or `null` if it is not this owner's or does not exist. */
  get(owner: Owner, id: JobId): ImportJob | null;
}

/**
 * The write half. Only the runner (and the submit route, for `create`) holds one. The transitions
 * are guarded on the *current* status inside the store, so a double-processed or already-terminal
 * job cannot be moved twice — the guard is a fact of the write, not of the caller's discipline.
 */
export interface JobWriter {
  /** Record a new `queued` job for these images (≥ 1, in page order). Mints the id. */
  create(owner: Owner, imageKeys: BlobKey[]): ImportJob;
  /**
   * Atomically take the oldest `queued` job across all owners into `running`, incrementing its
   * attempt count, or return `null` when nothing is waiting. The runner is a system actor, so this
   * is not owner-scoped. Atomic so that even a future multi-process pool cannot claim one job twice.
   */
  claim(): ImportJob | null;
  /**
   * `running` → `succeeded`, storing the recognised objects and the score the import landed (V11).
   * The runner maps the objects onto a `Score` and lands it through the applier *before* completing,
   * so a succeeded job always names the score it produced (V10's `scoreId: null` is gone). No-op
   * (returns `null`) if not running.
   */
  complete(id: JobId, result: OmrDocument[], scoreId: Id): ImportJob | null;
  /** `running` → `failed`, storing the diagnostic. No-op (returns `null`) if not running. */
  fail(id: JobId, diagnostic: string): ImportJob | null;
  /**
   * `failed` → `queued`, for a retry the user asked for (Q80). Owner-scoped: retrying is a user
   * action. Returns the requeued job, or `null` if it is missing, not this owner's, or not failed.
   */
  retry(owner: Owner, id: JobId): ImportJob | null;
  /**
   * Move every `running` job back to a terminal `failed` on startup. The API is stateless (ADR-0001
   * #7), so a job left `running` when the process died is orphaned — nothing is calling the worker
   * for it. Failing it (retryable) rather than silently requeuing avoids an interrupted job that
   * crashes the worker looping forever. Returns how many it recovered.
   */
  recover(diagnostic: string): number;
}

export interface JobStore extends JobReader, JobWriter {
  close(): void;
}
