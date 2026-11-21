import { randomUUID } from 'node:crypto';
import { isPresigning } from '../blob/blob-store.js';
import type { ManagedBlobStore } from '../blob/blob-store.js';
import type { AudioJob, AudioJobId, AudioJobReader, AudioJobStore } from '../store/audio-jobs.js';
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
  receive(owner: Owner, id: AudioJobId, bytes: Buffer): Promise<AudioJob | null>;
  /** The client says it has uploaded: check the store, then queue the job. */
  confirm(owner: Owner, id: AudioJobId): Promise<ConfirmAudioResult>;
  /** Requeue a failed job (Q80); `null` if missing, not this owner's, or not failed. */
  retry(owner: Owner, id: AudioJobId): Promise<AudioJob | null>;
  /** Remove a job and its audio. `false` if it is missing or not this owner's. */
  remove(owner: Owner, id: AudioJobId): Promise<boolean>;
}

export interface AudioServiceOptions {
  jobs: AudioJobStore;
  blobs: ManagedBlobStore;
  limits?: Partial<AudioLimits>;
  /** How long a presigned upload URL lives, seconds. */
  uploadUrlTtlSeconds?: number;
  /** Called after a job becomes `queued` or is requeued, so a future in-process dispatcher can wake. */
  onQueued?: () => void;
  now?: () => Date;
}

export function createAudioService(options: AudioServiceOptions): AudioService {
  const { jobs, blobs } = options;
  const limits: AudioLimits = { ...DEFAULT_AUDIO_LIMITS, ...options.limits };
  const ttl = options.uploadUrlTtlSeconds ?? 900;

  function target(job: AudioJob): UploadTarget {
    if (isPresigning(blobs)) {
      const signed = blobs.presignPut(job.audioKey, { expiresInSeconds: ttl, contentType: job.contentType });
      return { url: signed.url, method: 'PUT', headers: signed.headers, expiresAt: signed.expiresAt, viaApi: false };
    }
    return {
      url: `/v1/audio/jobs/${encodeURIComponent(job.id)}/content`,
      method: 'PUT',
      headers: { 'Content-Type': job.contentType },
      viaApi: true,
    };
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
      const job = await jobs.create(owner, {
        audioKey: `audio:${randomUUID()}`,
        contentType,
        filename,
        sizeBytes: size,
        instrument,
        declaredDurationSeconds: typeof duration === 'number' ? duration : null,
      });
      return { ok: true, job, upload: target(job) };
    },

    async receive(owner, id, bytes) {
      const job = await jobs.get(owner, id);
      if (job === null || job.status !== 'awaiting-upload') return null;
      await blobs.put(job.audioKey, bytes);
      return job;
    },

    async confirm(owner, id) {
      const job = await jobs.get(owner, id);
      if (job === null) return { ok: false, kind: 'no-such-job' };
      // Idempotent: confirming a job that has already moved on is not an error, it is the same answer.
      if (job.status !== 'awaiting-upload') return { ok: true, job };
      const stored = await blobs.stat(job.audioKey);
      if (stored === null) {
        return { ok: false, kind: 'audio-not-uploaded', message: 'no audio has arrived for this job yet; upload it first' };
      }
      if (stored.size > limits.maxBytes) {
        await blobs.delete(job.audioKey);
        return {
          ok: false,
          kind: 'audio-too-large',
          message: `the uploaded audio is ${stored.size} bytes; the cap is ${limits.maxBytes}`,
          maxBytes: limits.maxBytes,
        };
      }
      const queued = await jobs.markUploaded(owner, id, stored.size);
      options.onQueued?.();
      // A concurrent confirm may have won; the row is then already queued, which is the outcome asked for.
      return { ok: true, job: queued ?? (await jobs.get(owner, id)) ?? job };
    },

    async retry(owner, id) {
      const job = await jobs.retry(owner, id);
      if (job !== null) options.onQueued?.();
      return job;
    },

    async remove(owner, id) {
      const removed = await jobs.delete(owner, id);
      if (removed === null) return false;
      // The audio goes with the job (decision 16). A blob that was never uploaded is not an error.
      await blobs.delete(removed.audioKey);
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
