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
  /** The failure reason when `failed` (Q80); `null` otherwise. */
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
}

export interface AudioJobStore extends AudioJobReader, AudioJobWriter {
  close(): Promise<void>;
}
