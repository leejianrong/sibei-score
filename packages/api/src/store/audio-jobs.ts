import type { Id } from '@sibei/model';
import type { BlobKey } from '../blob/blob-store.js';
import type { Owner } from './repository.js';

/**
 * The audio-job store: the durable queue behind "audio is a job, not a request" (ADR-0001, ADR-0034
 * amendment decisions 14-17, SIB2-137).
 *
 * The second kind of job beside the OMR import (`jobs.ts`), in its own table and port rather than a
 * `kind` column on `import_jobs`: an audio job has a lease and a worker that *pulls* it (decision 14),
 * a result that is a NoteEvents document rather than a list of `OmrDocument`s, and an upload that
 * happens after the row exists. Sharing the table would have made every column nullable for one kind
 * or the other. It follows the import store's conventions: owner-scoped reads and a write half only
 * its holder may name, guards on the *current* status inside the store, a failed job commits nothing
 * (Q80), and no file here names a database.
 *
 * **This slice (SIB2-137) is the user-facing half:** create, upload confirmation, list, show, retry,
 * delete. The worker half (claim, heartbeat, complete, fail, lease expiry) is SIB2-138 and adds
 * methods to the *same* port; the columns it needs (`attempts`, `leaseToken`, `leaseExpiresAt`,
 * `progress`, `result`, `durationSeconds`) are in the schema from the start so that is not a migration.
 */

export type AudioJobId = string;

/**
 * The lifecycle. Closed, because the wire names it and `/v1/` is additive-only (ADR-0034 decision 13):
 *
 *   - `awaiting-upload` — the row exists and the client has been told where to put the bytes.
 *   - `queued`          — the audio is in the blob store (size checked); waiting for a worker.
 *   - `running`         — a worker holds a lease on it.
 *   - `succeeded`       — the worker returned a NoteEvents result.
 *   - `failed`          — `diagnostic` says why; retryable by its owner, and it committed nothing.
 */
export type AudioJobStatus = 'awaiting-upload' | 'queued' | 'running' | 'succeeded' | 'failed';

export interface AudioProgress {
  /** A short label the worker chose, shown as-is. */
  stage: string;
  /** 0 to 1. */
  fraction: number;
}

export interface AudioJob {
  id: AudioJobId;
  owner: Owner;
  status: AudioJobStatus;
  /** BlobStore key of the uploaded audio. Removed from the store when the job ends (decision 16). */
  audioKey: BlobKey;
  /** What the client said it is, validated against an allow-list at the boundary (ADR-0029). */
  contentType: string;
  /** The original name, for the user's list only. Never used as a path. */
  filename: string | null;
  /** The size the client declared, then the size the store confirmed. */
  sizeBytes: number;
  /** The instrument the user asked the engine to transcribe, passed through; `null` lets it decide. */
  instrument: string | null;
  /** The length the client's metadata claimed. Advisory; the metered figure is `durationSeconds`. */
  declaredDurationSeconds: number | null;
  /** How many times a worker has leased this job. 0 until the first claim. */
  attempts: number;
  /** A short slug for the failure (`unsupported-audio`, `worker-lost`, ...); `null` unless failed. */
  diagnosticKind: string | null;
  /** The failure reason when `failed` (Q80); the import's warnings when `succeeded` with a draft; else `null`. */
  diagnostic: string | null;
  progress: AudioProgress | null;
  /** The audio length the worker decoded, when `succeeded`: the metering input (decision 17). */
  durationSeconds: number | null;
  /** The NoteEvents v1 document when `succeeded`; opaque here, the audio repo owns its schema. */
  result: unknown | null;
  /** The score the import hook produced from the result; `null` until the importer lands one. */
  scoreId: Id | null;
  /** Opaque to everyone but the lease holder; `null` unless `running`. Never listed to the user. */
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** What a listing returns: no result document, no lease token. */
export type AudioJobSummary = Omit<AudioJob, 'result' | 'leaseToken'>;

export interface NewAudioJob {
  /** The blob key the upload will land under; minted by the service, which signs a URL for it. */
  audioKey: BlobKey;
  contentType: string;
  filename: string | null;
  sizeBytes: number;
  instrument: string | null;
  declaredDurationSeconds: number | null;
}

export interface AudioJobReader {
  /** This owner's audio jobs, newest first, without results. */
  list(owner: Owner): Promise<AudioJobSummary[]>;
  /** One job in full, or `null` if it is not this owner's or does not exist. */
  get(owner: Owner, id: AudioJobId): Promise<AudioJob | null>;
}

export interface AudioJobWriter {
  /** Record a new `awaiting-upload` job. Mints the id. */
  create(owner: Owner, job: NewAudioJob): Promise<AudioJob>;
  /**
   * `awaiting-upload` → `queued`, once the audio is in the store. `sizeBytes` is the size the *store*
   * reports, which replaces the declared one. `null` if the job is missing, not this owner's, or not
   * awaiting an upload — confirming twice is therefore harmless.
   */
  markUploaded(owner: Owner, id: AudioJobId, sizeBytes: number): Promise<AudioJob | null>;
  /**
   * `failed` → `queued`, for a retry the user asked for (Q80). Owner-scoped. `null` if the job is
   * missing, not this owner's, or not failed.
   */
  retry(owner: Owner, id: AudioJobId): Promise<AudioJob | null>;
  /**
   * Remove the job, whatever its state. Owner-scoped; returns the removed row (so the caller can drop
   * its blob) or `null`. A worker holding a lease on it learns at its next heartbeat (`cancelled`).
   */
  delete(owner: Owner, id: AudioJobId): Promise<AudioJob | null>;
  /**
   * Delete every audio job this owner has and return each one's id and audio key (V25, account deletion), so
   * the caller can delete the audio and result objects too. Not a request-path operation.
   */
  deleteAll(owner: Owner): Promise<{ id: AudioJobId; audioKey: BlobKey }[]>;
}

/**
 * What a transition under a lease answers (SIB2-138, the worker protocol in ADR-0034):
 *   - `ok`         the lease holder's call took effect.
 *   - `already`    the same lease token already did this (a repeated `complete` or `fail`), so the answer is
 *                  the same and nothing changed: the idempotency a worker that lost a response relies on.
 *   - `lease-lost` the token is not the current holder's (the job was re-queued and perhaps claimed by
 *                  another worker, or deleted): abandon the work.
 */
export type LeaseOutcome = { outcome: 'ok' | 'already'; job: AudioJob } | { outcome: 'lease-lost' };

/**
 * The half only the pulling worker's service holds (decision 14). Not owner-scoped: a worker takes the
 * oldest queued job across all users, which is the system actor (Postgres admits it by `app.system` on
 * this table only, and never to a score). Every call but `claim` and `expireLeases` is guarded on the
 * lease token inside the store, so a stale worker cannot move a job that was re-queued.
 */
export interface AudioJobWorkerStore {
  /** Take the oldest `queued` job into `running` with a fresh lease, or `null` when nothing is waiting. */
  claim(leaseSeconds: number): Promise<AudioJob | null>;
  /** Extend the lease (and record progress). `lease-lost` unless the token holds a running job. */
  heartbeat(id: AudioJobId, leaseToken: string, leaseSeconds: number, progress: AudioProgress | null): Promise<LeaseOutcome>;
  /** `running` → `succeeded`, storing the result and the decoded duration. */
  complete(id: AudioJobId, leaseToken: string, result: unknown, durationSeconds: number): Promise<LeaseOutcome>;
  /**
   * End an attempt that failed. `retryable` with attempts left re-queues it (the lease token stays on the
   * row so a repeated `fail` is `already`); otherwise it is `failed` for good with this kind and message.
   */
  fail(
    id: AudioJobId,
    leaseToken: string,
    failure: { kind: string; message: string; retryable: boolean; maxAttempts: number },
  ): Promise<LeaseOutcome>;
  /**
   * Re-queue every `running` job whose lease has passed, or fail it as `worker-lost` once it has used
   * `maxAttempts`. Returns the jobs it moved so the caller can drop the audio of the ones now failed.
   */
  expireLeases(maxAttempts: number): Promise<{ requeued: AudioJob[]; failed: AudioJob[] }>;
  /**
   * Delete every job still `awaiting-upload` that was created before `beforeIso` and return the rows, so the
   * caller can drop any object a presigned URL may have written (SEC H4). A job whose client never uploaded
   * would otherwise sit counting against its owner forever. System-level, not a request-path operation.
   */
  deleteStaleUploads(beforeIso: string): Promise<AudioJob[]>;
  /** A job by id, any owner: the worker service's own read. Never reachable from a user route. */
  getById(id: AudioJobId): Promise<AudioJob | null>;
  /**
   * Record the score the import hook produced from the result, and the engine's warnings about it as the
   * job's `diagnostic` (a `succeeded` job's diagnostic is advisory, not a failure reason; `null` clears it).
   */
  attachScore(id: AudioJobId, scoreId: Id, diagnostic?: string | null): Promise<AudioJob | null>;
  /** The import hook refused the result: `succeeded` → `failed` (non-retryable), keeping the result. */
  rejectResult(id: AudioJobId, kind: string, message: string): Promise<AudioJob | null>;
}

/**
 * The audio-second ledger (SIB2-139, decision 17): how much audio each user has had transcribed. Written
 * once per job by the worker side, read by its owner (the Audio page, `sbscore audio usage`) and, with
 * SIB2-140, by the cap check that runs when a job is created. Money is not here: this is the input to
 * whatever pricing decision follows.
 */
export interface AudioUsageLedger {
  /**
   * Add `seconds` for this job, **once**: the key is the job id, so recording it again — a retried
   * `complete`, a result the importer refused and a re-run that then succeeded — changes nothing and
   * answers `false`. Not owner-scoped on the way in (the worker holds no owner), but the owner is stored.
   */
  recordUsage(owner: Owner, jobId: AudioJobId, seconds: number): Promise<boolean>;
  /** This owner's total since `sinceIso` (inclusive), and how many jobs made it up. */
  usageSince(owner: Owner, sinceIso: string): Promise<{ seconds: number; jobs: number }>;
}

export interface AudioJobStore extends AudioJobReader, AudioJobWriter, AudioJobWorkerStore, AudioUsageLedger {
  close(): Promise<void>;
}
