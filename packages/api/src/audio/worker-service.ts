import type { Id } from '@sibei/model';
import { hashToken, sameSecret } from '../auth/secrets.js';
import { isPresigning } from '../blob/blob-store.js';
import type { ManagedBlobStore } from '../blob/blob-store.js';
import type { AudioJob, AudioJobId, AudioJobStore, AudioProgress } from '../store/audio-jobs.js';

/**
 * The audio worker's side of the queue (SIB2-138, "Audio worker protocol v1" in the ADR-0034 amendment).
 *
 * The audio engine runs on a GPU in another repository and **pulls**: it claims a job under a lease,
 * heartbeats while it works, and completes or fails it (decision 14). This service is everything the
 * `/v1/worker/audio/*` routes do, kept apart from the user-facing `AudioService` so the two cannot share a
 * capability by accident: it holds no score reader, no library and no applier, and the only thing it can
 * hand onward is a NoteEvents document, through {@link AudioResultImporter}.
 *
 * **The credential is not a user.** Worker tokens (`sbsw_…`) are configured by the operator and held here
 * only as SHA-256 digests; a match authorises `/v1/worker/*` and nothing else. They carry no owner, so the
 * worker can reach no user's scores, library or other jobs — only the job it holds a lease on, by id and
 * lease token.
 *
 * **Bytes never cross the API when there is object storage** (decision 15): claim returns a presigned GET
 * for the audio and a presigned PUT for the result. With the local directory store there is nothing to
 * sign, so the audio is served by `contentFor` and the result travels inline in `complete`.
 *
 * **Retention** (decision 16): the audio is deleted the moment a job ends — succeeded, failed for good, or
 * failed by an expired lease — whatever else happens.
 */

export interface AudioWorkerOptions {
  /** The plaintext worker credentials (`sbsw_…`). Hashed on the way in; never kept or logged. */
  tokens: readonly string[];
  /** How long a lease lasts after a claim or heartbeat. Default 120. */
  leaseSeconds?: number;
  /** How often the worker is told to heartbeat. Default 30. */
  heartbeatSeconds?: number;
  /** Attempts a job gets before a lost lease or a retryable failure ends it. Default 3. */
  maxAttempts?: number;
  /** Lifetime of the presigned audio GET. Default 3600. */
  audioUrlTtlSeconds?: number;
  /** Lifetime of the presigned result PUT. Default 7200. */
  resultUrlTtlSeconds?: number;
  /** The largest inline or uploaded result. Default 32 MiB. */
  maxResultBytes?: number;
  /** How often expired leases are swept while the server is listening. Default 15000. */
  sweepIntervalMs?: number;
  now?: () => Date;
}

/**
 * The import hook. The result is a NoteEvents v1 document, whose schema the audio repo owns and the
 * validator and importer (SIB2-E9) enforce. This port is where that work plugs in: it validates, imports
 * through the applier's server-only `import`, and answers with the score it made or the reason it
 * refused. Absent, a job simply succeeds with its result stored and no score.
 */
export interface AudioResultImporter {
  importResult(job: AudioJob, noteEvents: unknown): Promise<{ ok: true; scoreId: Id } | { ok: false; kind: string; message: string }>;
}

export const WORKER_TOKEN_PREFIX = 'sbsw_';

export interface ClaimedJob {
  id: AudioJobId;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
  heartbeatIntervalSeconds: number;
  audio: WorkerTransfer;
  params: { instrument: string | null; declaredDurationSeconds: number | null };
  resultUpload?: WorkerTransfer;
}

/** Where to get the audio or put the result: a presigned URL, or this API's own route with the lease header. */
export interface WorkerTransfer {
  url: string;
  method: 'GET' | 'PUT';
  headers: Record<string, string>;
  expiresAt?: string;
  contentType?: string;
  sizeBytes?: number;
  viaApi: boolean;
}

export type WorkerResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: 'lease-lost' | 'no-such-job' }
  | { ok: false; kind: 'bad-request' | 'invalid-result' | 'body-too-large'; message: string };

export interface CompleteInput {
  leaseToken: unknown;
  durationSeconds: unknown;
  result: unknown;
}

export interface AudioWorkerService {
  /** Is this `Authorization` header a worker credential this server knows? */
  authenticate(header: string | undefined): boolean;
  claim(input: { waitSeconds?: number }): Promise<ClaimedJob | null>;
  heartbeat(id: AudioJobId, input: { leaseToken: unknown; progress?: unknown }): Promise<WorkerResult<{ leaseExpiresAt: string | null; cancelled: boolean; audio: WorkerTransfer | null }>>;
  complete(id: AudioJobId, input: CompleteInput): Promise<WorkerResult<{ status: AudioJob['status']; alreadyCompleted?: true }>>;
  fail(id: AudioJobId, input: { leaseToken: unknown; kind?: unknown; message?: unknown; retryable?: unknown }): Promise<WorkerResult<{ status: AudioJob['status'] }>>;
  /** The audio bytes, for the local store that cannot presign. The lease token is the capability. */
  contentFor(id: AudioJobId, leaseToken: string | undefined): Promise<{ bytes: Buffer; contentType: string } | null>;
  /** Re-queue or fail every job whose lease has lapsed. Called on every claim and on a timer. */
  sweep(): Promise<void>;
  startSweeper(onError: (error: unknown) => void): void;
  stopSweeper(): void;
}

const resultKey = (id: AudioJobId): string => `audio-result:${id}`;

export function createAudioWorkerService(options: {
  jobs: AudioJobStore;
  blobs: ManagedBlobStore;
  worker: AudioWorkerOptions;
  importer?: AudioResultImporter;
}): AudioWorkerService {
  const { jobs, blobs, importer } = options;
  const config = options.worker;
  const leaseSeconds = config.leaseSeconds ?? 120;
  const heartbeatSeconds = config.heartbeatSeconds ?? 30;
  const maxAttempts = config.maxAttempts ?? 3;
  const audioTtl = config.audioUrlTtlSeconds ?? 3600;
  const resultTtl = config.resultUrlTtlSeconds ?? 7200;
  const maxResultBytes = config.maxResultBytes ?? 32 * 1024 * 1024;
  const now = config.now ?? (() => new Date());
  const digests = config.tokens.map((token) => hashToken(token));
  let timer: ReturnType<typeof setInterval> | undefined;

  function audioTransfer(job: AudioJob): WorkerTransfer {
    if (isPresigning(blobs)) {
      const signed = blobs.presignGet(job.audioKey, { expiresInSeconds: audioTtl });
      return {
        url: signed.url,
        method: 'GET',
        headers: signed.headers,
        expiresAt: new Date(signed.expiresAt).toISOString(),
        contentType: job.contentType,
        sizeBytes: job.sizeBytes,
        viaApi: false,
      };
    }
    return {
      url: `/v1/worker/audio/jobs/${encodeURIComponent(job.id)}/content`,
      method: 'GET',
      headers: { 'x-lease-token': job.leaseToken ?? '' },
      contentType: job.contentType,
      sizeBytes: job.sizeBytes,
      viaApi: true,
    };
  }

  function tokenOf(value: unknown): string | null {
    return typeof value === 'string' && value !== '' && value.length <= 200 ? value : null;
  }

  /** The audio goes the moment the job ends (decision 16). A blob that is already gone is not an error. */
  async function dropAudio(job: AudioJob): Promise<void> {
    await blobs.delete(job.audioKey);
  }

  async function sweep(): Promise<void> {
    const { failed } = await jobs.expireLeases(maxAttempts);
    for (const job of failed) await dropAudio(job);
  }

  return {
    authenticate(header) {
      const match = /^Bearer (sbsw_[A-Za-z0-9_-]+)$/.exec(header ?? '');
      if (match === null) return false;
      const digest = hashToken(match[1]!);
      // Every digest is compared, with no early exit, so how many credentials exist and which one matched
      // is not something timing can tell.
      let found = false;
      for (const known of digests) if (sameSecret(known, digest)) found = true;
      return found;
    },

    async claim({ waitSeconds }) {
      const wait = Math.min(Math.max(typeof waitSeconds === 'number' ? waitSeconds : 0, 0), 30);
      const deadline = Date.now() + wait * 1000;
      for (;;) {
        await sweep();
        const job = await jobs.claim(leaseSeconds);
        if (job !== null) {
          const claimed: ClaimedJob = {
            id: job.id,
            attempt: job.attempts,
            leaseToken: job.leaseToken!,
            leaseExpiresAt: job.leaseExpiresAt!,
            heartbeatIntervalSeconds: heartbeatSeconds,
            audio: audioTransfer(job),
            params: { instrument: job.instrument, declaredDurationSeconds: job.declaredDurationSeconds },
          };
          if (isPresigning(blobs)) {
            const signed = blobs.presignPut(resultKey(job.id), { expiresInSeconds: resultTtl, contentType: 'application/json' });
            claimed.resultUpload = {
              url: signed.url,
              method: 'PUT',
              headers: signed.headers,
              expiresAt: new Date(signed.expiresAt).toISOString(),
              viaApi: false,
            };
          }
          return claimed;
        }
        if (Date.now() >= deadline) return null;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },

    async heartbeat(id, input) {
      const token = tokenOf(input.leaseToken);
      if (token === null) return { ok: false, kind: 'bad-request', message: 'leaseToken is required' };
      const progress = progressOf(input.progress);
      if (progress === false) return { ok: false, kind: 'bad-request', message: 'progress must be { stage: string, fraction: 0..1 }' };
      const beat = await jobs.heartbeat(id, token, leaseSeconds, progress);
      if (beat.outcome === 'lease-lost') {
        // A job its owner deleted is not a stolen lease: say so, so the worker discards instead of retrying.
        if ((await jobs.getById(id)) === null) return { ok: true, value: { leaseExpiresAt: null, cancelled: true, audio: null } };
        return { ok: false, kind: 'lease-lost' };
      }
      return {
        ok: true,
        value: {
          leaseExpiresAt: beat.job.leaseExpiresAt!,
          cancelled: false,
          // A fresh presigned GET each time, so a long job never works against a URL that has lapsed.
          audio: isPresigning(blobs) ? audioTransfer(beat.job) : null,
        },
      };
    },

    async complete(id, input) {
      const token = tokenOf(input.leaseToken);
      if (token === null) return { ok: false, kind: 'bad-request', message: 'leaseToken is required' };
      const seconds = input.durationSeconds;
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) {
        return { ok: false, kind: 'bad-request', message: 'durationSeconds must be a positive number of seconds, at most a day' };
      }

      // Look before taking: a job that is not this lease's must answer lease-lost whatever the body says,
      // and the result is only read from the bucket for the lease that holds the job.
      const current = await jobs.getById(id);
      if (current === null || current.leaseToken !== token) return { ok: false, kind: 'lease-lost' };
      if (current.status === 'succeeded') return { ok: true, value: { status: 'succeeded', alreadyCompleted: true } };

      const read = await readResult(id, input.result);
      if (!read.ok) return read;

      const done = await jobs.complete(id, token, read.value, seconds);
      if (done.outcome === 'lease-lost') return { ok: false, kind: 'lease-lost' };
      if (done.outcome === 'already') return { ok: true, value: { status: 'succeeded', alreadyCompleted: true } };

      await dropAudio(done.job);
      await blobs.delete(resultKey(id));

      let status: AudioJob['status'] = 'succeeded';
      if (importer !== undefined) {
        const imported = await importer.importResult(done.job, read.value).catch(
          (): { ok: false; kind: string; message: string } => ({
            ok: false,
            kind: 'import-failed',
            message: 'the result could not be imported',
          }),
        );
        if (imported.ok) await jobs.attachScore(id, imported.scoreId);
        else {
          await jobs.rejectResult(id, imported.kind, imported.message);
          status = 'failed';
        }
      }
      return { ok: true, value: { status } };
    },

    async fail(id, input) {
      const token = tokenOf(input.leaseToken);
      if (token === null) return { ok: false, kind: 'bad-request', message: 'leaseToken is required' };
      const kind = typeof input.kind === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(input.kind) ? input.kind : 'engine-error';
      const message = (typeof input.message === 'string' ? input.message : 'the transcription worker reported a failure').slice(0, 500);
      const out = await jobs.fail(id, token, { kind, message, retryable: input.retryable === true, maxAttempts });
      if (out.outcome === 'lease-lost') return { ok: false, kind: 'lease-lost' };
      if (out.job.status === 'failed') await dropAudio(out.job);
      return { ok: true, value: { status: out.job.status } };
    },

    async contentFor(id, leaseToken) {
      if (leaseToken === undefined) return null;
      const job = await jobs.getById(id);
      if (job === null || job.status !== 'running' || job.leaseToken !== leaseToken) return null;
      const bytes = await blobs.get(job.audioKey);
      return bytes === null ? null : { bytes, contentType: job.contentType };
    },

    sweep,

    startSweeper(onError) {
      if (timer !== undefined) return;
      timer = setInterval(() => void sweep().catch(onError), config.sweepIntervalMs ?? 15_000);
      timer.unref();
    },
    stopSweeper() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };

  /** The NoteEvents document, inline or from the upload target. Schema validation is the importer's, not ours. */
  async function readResult(id: AudioJobId, result: unknown): Promise<WorkerResult<unknown>> {
    const shape = result as { inline?: unknown; uploaded?: unknown } | null;
    if (shape !== null && typeof shape === 'object' && shape.inline !== undefined) {
      if (typeof shape.inline !== 'object' || shape.inline === null) {
        return { ok: false, kind: 'invalid-result', message: 'result.inline must be a NoteEvents JSON object' };
      }
      return { ok: true, value: shape.inline };
    }
    if (shape !== null && typeof shape === 'object' && shape.uploaded === true) {
      const stored = await blobs.stat(resultKey(id));
      if (stored === null) return { ok: false, kind: 'bad-request', message: 'result.uploaded is true but nothing was uploaded to the result URL' };
      if (stored.size > maxResultBytes) {
        await blobs.delete(resultKey(id));
        return { ok: false, kind: 'body-too-large', message: `the result is ${stored.size} bytes; the cap is ${maxResultBytes}` };
      }
      const bytes = await blobs.get(resultKey(id));
      try {
        const parsed = JSON.parse(bytes?.toString('utf8') ?? '') as unknown;
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
        return { ok: true, value: parsed };
      } catch {
        return { ok: false, kind: 'invalid-result', message: 'the uploaded result is not a JSON object' };
      }
    }
    return { ok: false, kind: 'bad-request', message: 'result must be { inline: <NoteEvents> } or { uploaded: true }' };
  }
}

function progressOf(value: unknown): AudioProgress | null | false {
  if (value === undefined || value === null) return null;
  const p = value as { stage?: unknown; fraction?: unknown };
  if (typeof p.stage !== 'string' || p.stage === '' || p.stage.length > 60) return false;
  if (typeof p.fraction !== 'number' || !(p.fraction >= 0 && p.fraction <= 1)) return false;
  return { stage: p.stage, fraction: p.fraction };
}
