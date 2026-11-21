import { randomUUID } from 'node:crypto';
import { QuotaError } from '../limits/errors.js';
import { audioCapFor } from './quota.js';
import type { AudioQuotaConfig } from './quota.js';
import { isPresigning } from '../blob/blob-store.js';
import type { ManagedBlobStore } from '../blob/blob-store.js';
import type { AudioJob, AudioJobId, AudioJobReader, AudioJobStore } from '../store/audio-jobs.js';
import type { BlobLedger } from '../store/blob-ledger.js';
import type { Owner } from '../store/repository.js';

/**
 * The audio-job service (SIB2-137, ADR-0034 amendment decisions 14-17): what the routes are handed in
 * place of the store and the blob store. It is the upload boundary for audio — the sibling of
 * `imports/upload.ts` — and the only thing that creates, confirms, retries and deletes a user's audio
 * jobs. It runs **without any worker**: a job is accepted and waits `queued`, and the API is fully
 * functional with the audio worker stopped (the card's acceptance criterion).
 *
 * **Where the bytes go.** With an object store (`isPresigning`) `create` hands back a presigned `PUT`
 * and the browser or CLI uploads straight to the bucket; nothing crosses the API (decision 15). With
 * the local directory store there is nothing to sign, so the same shape is returned pointing at this
 * API's own `PUT /v1/audio/jobs/:id/content` (`viaApi`), and local mode keeps working unchanged. Either
 * way the client then calls `confirm`, which checks the object exists and is within the size cap
 * before the job becomes `queued` — a declared size is a claim, the store's `stat` is the fact.
 */

export interface AudioLimits {
  /** The largest upload, in bytes. */
  maxBytes: number;
  /** The content types accepted. A claim from the client, checked against this list at create. */
  contentTypes: readonly string[];
}

/**
 * What one user may have in flight at once (SEC H4): jobs that are `awaiting-upload`, `queued` or `running`
 * hold audio in the blob store, on the same disk as the database in a single-VM deploy. Absent means no cap,
 * which is the local default; `sbscore serve` supplies `HOSTED_AUDIO_HOLD` in hosted mode.
 */
export interface AudioHoldCaps {
  maxInFlightJobs: number;
  maxInFlightBytes: number;
}

export const HOSTED_AUDIO_HOLD: AudioHoldCaps = { maxInFlightJobs: 3, maxInFlightBytes: 300 * 1024 * 1024 };

/** The key a presigned PUT writes to. Never read by anything; confirm copies it onto the job's own key (SEC M1). */
export const uploadKeyFor = (jobId: string): string => `audio-upload:${jobId}`;

export const DEFAULT_AUDIO_LIMITS: AudioLimits = {
  maxBytes: 100 * 1024 * 1024,
  contentTypes: [
    'audio/wav',
    'audio/x-wav',
    'audio/mpeg',
    'audio/mp4',
    'audio/aac',
    'audio/flac',
    'audio/x-flac',
    'audio/ogg',
    'audio/webm',
  ],
};

/** The instruments the audio engine accepts, passed through. The engine owns the set; this only bounds it. */
const INSTRUMENT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export interface CreateAudioInput {
  filename?: unknown;
  contentType?: unknown;
  sizeBytes?: unknown;
  instrument?: unknown;
  durationSeconds?: unknown;
}

/** Where to put the bytes. Shaped like `PresignedRequest` so a client has one path for both modes. */
export interface UploadTarget {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  /** When a presigned URL stops working, epoch ms; absent for the API's own route. */
  expiresAt?: number;
  /** True when `url` is this API's own route (local mode): the request carries the session like any other. */
  viaApi: boolean;
}

export type AudioRefusal =
  | { ok: false; kind: 'validation'; message: string }
  | { ok: false; kind: 'unsupported-audio-type'; message: string; allowed: readonly string[] }
  | { ok: false; kind: 'audio-too-large'; message: string; maxBytes: number };

export type CreateAudioResult = { ok: true; job: AudioJob; upload: UploadTarget } | AudioRefusal;

export type ConfirmAudioResult =
  | { ok: true; job: AudioJob }
  | { ok: false; kind: 'no-such-job' }
  | { ok: false; kind: 'audio-not-uploaded'; message: string }
  | { ok: false; kind: 'audio-too-large'; message: string; maxBytes: number };

export interface AudioService {
  limits: AudioLimits;
  reader: AudioJobReader;
  create(owner: Owner, input: CreateAudioInput): Promise<CreateAudioResult>;
  /** The local-mode upload: store the bytes under the job's key. `null` unless the job is awaiting an upload. */
  receive(owner: Owner, id: AudioJobId, bytes: Buffer): Promise<AudioJob | null | 'too-large'>;
  /** The client says it has uploaded: check the store, then queue the job. */
  confirm(owner: Owner, id: AudioJobId): Promise<ConfirmAudioResult>;
  /**
   * Requeue a failed job (Q80); `null` if missing, not this owner's, or not failed. `audio-gone` when the
   * audio object was already deleted (decision 16: it goes when a job ends) — a worker would claim the job
   * and fail on missing audio, so the person has to upload again.
   */
  retry(owner: Owner, id: AudioJobId): Promise<AudioJob | null | { kind: 'audio-gone'; message: string }>;
  /** What this owner has had transcribed this period (a calendar month, UTC), from the ledger. */
  usage(owner: Owner): Promise<AudioUsage>;
  /** Remove a job and its audio. `false` if it is missing or not this owner's. */
  remove(owner: Owner, id: AudioJobId): Promise<boolean>;
}

/** The ledger read for one owner and one period. */
export interface AudioUsage {
  /** Inclusive start and exclusive end of the period, ISO-8601 UTC. */
  periodStart: string;
  periodEnd: string;
  /** Audio-seconds transcribed in the period. */
  seconds: number;
  /** This user's allowance for the period in audio-seconds, or `null` when they have none (SIB2-140). */
  capSeconds: number | null;
  /** How many jobs that was. */
  jobs: number;
}

/** The calendar month containing `at`, UTC: the period usage is counted in until plans exist (decision 17). */
export function usagePeriod(at: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  const iso = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
  return { start: iso(start), end: iso(end) };
}

export interface AudioServiceOptions {
  jobs: AudioJobStore;
  blobs: ManagedBlobStore;
  /**
   * Records each audio object against its owner (V25), so account deletion and the sweep can find it. The
   * key is recorded when the job is created, before any bytes exist: deleting an absent object is not an error.
   */
  ledger?: BlobLedger;
  limits?: Partial<AudioLimits>;
  /** The audio-second allowance (SIB2-140). Absent means no cap. */
  quota?: AudioQuotaConfig;
  /** Per-user in-flight jobs and bytes (SEC H4). Absent means no cap. */
  hold?: AudioHoldCaps;
  /** How long a presigned upload URL lives, seconds. */
  uploadUrlTtlSeconds?: number;
  /** Called after a job becomes `queued` or is requeued, so a future in-process dispatcher can wake. */
  onQueued?: () => void;
  now?: () => Date;
}

export function createAudioService(options: AudioServiceOptions): AudioService {
  const { jobs, blobs } = options;
  const limits: AudioLimits = { ...DEFAULT_AUDIO_LIMITS, ...options.limits };
  const ttl = options.uploadUrlTtlSeconds ?? 600;
  const now = options.now ?? (() => new Date());

  function target(job: AudioJob): UploadTarget {
    if (isPresigning(blobs)) {
      const signed = blobs.presignPut(uploadKeyFor(job.id), { expiresInSeconds: ttl, contentType: job.contentType });
      return { url: signed.url, method: 'PUT', headers: signed.headers, expiresAt: signed.expiresAt, viaApi: false };
    }
    return {
      url: `/v1/audio/jobs/${encodeURIComponent(job.id)}/content`,
      method: 'PUT',
      headers: { 'Content-Type': job.contentType },
      viaApi: true,
    };
  }

  /**
   * Refuse a new job when the period's allowance is used up (SIB2-140). What counts is the ledger (finished
   * work) plus the declared length of jobs still in flight, so a burst of uploads cannot overshoot the cap
   * before any of them has finished. A job with no declared length reserves nothing; the ledger catches it
   * when it completes, and the *next* job is the one refused. The refusal says how much, until when, and
   * what to do about it.
   */
  async function enforceAllowance(owner: Owner): Promise<void> {
    const cap = options.quota === undefined ? null : audioCapFor(options.quota, owner);
    if (cap === null) return;
    const period = usagePeriod(now());
    const [used, listed] = await Promise.all([jobs.usageSince(owner, period.start), jobs.list(owner)]);
    const reserved = listed
      .filter((job) => job.status === 'awaiting-upload' || job.status === 'queued' || job.status === 'running')
      .reduce((sum, job) => sum + (job.declaredDurationSeconds ?? 0), 0);
    if (used.seconds + reserved < cap) return;
    const minutes = (seconds: number) => `${Math.round((seconds / 60) * 10) / 10} minutes`;
    throw new QuotaError(
      'audio-seconds',
      cap,
      `You have used your ${minutes(cap)} of audio transcription for this period` +
        (reserved > 0 ? ` (${minutes(used.seconds)} done, ${minutes(reserved)} still waiting in your queue)` : '') +
        `. It renews on ${period.end.slice(0, 10)}. Until then you can delete jobs you no longer need, or ask the operator for a higher allowance.`,
      Math.max(1, Math.ceil((Date.parse(period.end) - now().getTime()) / 1000)),
    );
  }

  /** SEC H4: refuse a new job past the caller's in-flight job or byte budget. */
  async function enforceHold(owner: Owner, incomingBytes: number): Promise<void> {
    const hold = options.hold;
    if (hold === undefined) return;
    const live = (await jobs.list(owner)).filter((job) => job.status === 'awaiting-upload' || job.status === 'queued' || job.status === 'running');
    if (live.length >= hold.maxInFlightJobs) {
      throw new QuotaError(
        'audio-jobs',
        hold.maxInFlightJobs,
        `you already have ${live.length} recordings waiting or being transcribed (limit ${hold.maxInFlightJobs}); wait for one to finish or delete one`,
      );
    }
    const held = live.reduce((sum, job) => sum + job.sizeBytes, 0);
    if (held + incomingBytes > hold.maxInFlightBytes) {
      throw new QuotaError(
        'audio-bytes',
        hold.maxInFlightBytes,
        `your waiting recordings already hold ${Math.round(held / 1048576)} MB (limit ${Math.round(hold.maxInFlightBytes / 1048576)} MB); wait for one to finish or delete one`,
      );
    }
  }

  return {
    limits,
    reader: jobs,

    async create(owner, input) {
      const contentType = typeof input.contentType === 'string' ? input.contentType.toLowerCase().split(';')[0]!.trim() : '';
      if (!limits.contentTypes.includes(contentType)) {
        return {
          ok: false,
          kind: 'unsupported-audio-type',
          message: `${contentType === '' ? 'a content type' : JSON.stringify(contentType)} is not an audio type this server accepts; use one of ${limits.contentTypes.join(', ')}`,
          allowed: limits.contentTypes,
        };
      }
      const size = input.sizeBytes;
      if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
        return { ok: false, kind: 'validation', message: 'sizeBytes must be a positive whole number of bytes' };
      }
      if (size > limits.maxBytes) {
        return {
          ok: false,
          kind: 'audio-too-large',
          message: `audio is capped at ${limits.maxBytes} bytes; this is ${size}`,
          maxBytes: limits.maxBytes,
        };
      }
      const filename = optionalString(input.filename, 200);
      if (filename === false) return { ok: false, kind: 'validation', message: 'filename must be a string of at most 200 characters' };
      const instrument = optionalString(input.instrument, 32);
      if (instrument === false || (instrument !== null && !INSTRUMENT_PATTERN.test(instrument))) {
        return { ok: false, kind: 'validation', message: 'instrument must be a short lowercase name such as "piano"' };
      }
      const duration = input.durationSeconds;
      if (duration !== undefined && duration !== null && (typeof duration !== 'number' || !(duration > 0) || !Number.isFinite(duration))) {
        return { ok: false, kind: 'validation', message: 'durationSeconds must be a positive number' };
      }
      await enforceAllowance(owner);
      await enforceHold(owner, size);
      const job = await jobs.create(owner, {
        audioKey: `audio:${randomUUID()}`,
        contentType,
        filename,
        sizeBytes: size,
        instrument,
        declaredDurationSeconds: typeof duration === 'number' ? duration : null,
      });
      await options.ledger?.record(owner, job.audioKey, 'audio');
      // The key a presigned PUT writes to is ledgered too, so the sweep finds anything written there after the
      // job is gone (SEC M1).
      if (isPresigning(blobs)) await options.ledger?.record(owner, uploadKeyFor(job.id), 'audio');
      return { ok: true, job, upload: target(job) };
    },

    async receive(owner, id, bytes) {
      const job = await jobs.get(owner, id);
      if (job === null || job.status !== 'awaiting-upload') return null;
      // The declared size is what was budgeted (SEC H4); a body bigger than it is not the upload that was agreed.
      if (bytes.length > job.sizeBytes) return 'too-large';
      await blobs.put(job.audioKey, bytes);
      return job;
    },

    async confirm(owner, id) {
      const job = await jobs.get(owner, id);
      if (job === null) return { ok: false, kind: 'no-such-job' };
      // Idempotent: confirming a job that has already moved on is not an error, it is the same answer.
      if (job.status !== 'awaiting-upload') return { ok: true, job };
      const presigned = isPresigning(blobs);
      const sourceKey = presigned ? uploadKeyFor(job.id) : job.audioKey;
      const stored = await blobs.stat(sourceKey);
      if (stored === null) {
        return { ok: false, kind: 'audio-not-uploaded', message: 'no audio has arrived for this job yet; upload it first' };
      }
      if (stored.size > limits.maxBytes) {
        await blobs.delete(sourceKey);
        return {
          ok: false,
          kind: 'audio-too-large',
          message: `the uploaded audio is ${stored.size} bytes; the cap is ${limits.maxBytes}`,
          maxBytes: limits.maxBytes,
        };
      }
      if (presigned) {
        // The presigned URL stays valid until it expires, and it can write but not be unsigned. Move the bytes
        // onto the job's own key, which no URL can write, and drop the upload key: after this a late PUT can
        // only recreate an object nothing reads, and the sweep removes it (SEC M1).
        if (!(await blobs.copy(sourceKey, job.audioKey))) {
          return { ok: false, kind: 'audio-not-uploaded', message: 'no audio has arrived for this job yet; upload it first' };
        }
        await blobs.delete(sourceKey);
      }
      const queued = await jobs.markUploaded(owner, id, stored.size);
      options.onQueued?.();
      // A concurrent confirm may have won; the row is then already queued, which is the outcome asked for.
      return { ok: true, job: queued ?? (await jobs.get(owner, id)) ?? job };
    },

    async retry(owner, id) {
      const existing = await jobs.get(owner, id);
      if (existing !== null && existing.status === 'failed' && (await blobs.stat(existing.audioKey)) === null) {
        return { kind: 'audio-gone', message: 'the audio for this job was deleted when it failed; upload the recording again' };
      }
      const job = await jobs.retry(owner, id);
      if (job !== null) options.onQueued?.();
      return job;
    },

    async usage(owner) {
      const period = usagePeriod(now());
      const used = await jobs.usageSince(owner, period.start);
      const cap = options.quota === undefined ? null : audioCapFor(options.quota, owner);
      return { periodStart: period.start, periodEnd: period.end, seconds: used.seconds, capSeconds: cap, jobs: used.jobs };
    },

    async remove(owner, id) {
      const removed = await jobs.delete(owner, id);
      if (removed === null) return false;
      // The audio goes with the job (decision 16). A blob that was never uploaded is not an error.
      await blobs.delete(removed.audioKey);
      await blobs.delete(uploadKeyFor(removed.id));
      await options.ledger?.forget(owner, removed.audioKey);
      await blobs.delete(`audio-result:${removed.id}`);
      return true;
    },
  };
}

/** A trimmed optional string; `false` when it is present but not an acceptable string. */
function optionalString(value: unknown, max: number): string | null | false {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) return false;
  return value;
}
