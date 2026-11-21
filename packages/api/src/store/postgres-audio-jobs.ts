import { randomUUID } from 'node:crypto';
import type { Id } from '@sibei/model';
import type { Pool, PoolConfig } from 'pg';
import type { AudioJob, AudioJobId, AudioJobStore, AudioJobSummary, AudioProgress, LeaseOutcome } from './audio-jobs.js';
import { assertRlsEnforced, migratePostgres } from './postgres-schema.js';
import { asOwner, asSystem, closeHandle, poolFor } from './postgres-session.js';
import { timestamp } from './store-shared.js';

/**
 * The Postgres implementation of the audio-job port (SIB2-137, ADR-0034): the sibling of
 * `postgres-jobs.ts` and of `sqlite-audio-jobs.ts`, held to the same contract by the one conformance
 * suite. One of the files that may know Postgres exists (`tests/arch/store-seam.test.ts`).
 *
 * Every method here is owner-scoped, so every one runs `asOwner` and row-level security backs the
 * `WHERE owner` it also writes. The system-actor methods the pulling worker needs (claim, heartbeat,
 * complete, fail, expiry) arrive with SIB2-138; the policy on `audio_jobs` already admits `app.system`.
 */

export interface PostgresAudioJobStoreOptions {
  connectionString?: string;
  pool?: Pool;
  poolConfig?: PoolConfig;
  onError?: (error: Error) => void;
  now?: () => Date;
  newId?: () => AudioJobId;
  allowRlsBypass?: boolean;
}

interface AudioJobRow {
  id: string;
  owner: string;
  status: string;
  audio_key: string;
  content_type: string;
  filename: string | null;
  size_bytes: number;
  instrument: string | null;
  declared_duration_seconds: number | null;
  attempts: number;
  diagnostic_kind: string | null;
  diagnostic: string | null;
  progress: string | null;
  duration_seconds: number | null;
  result: string | null;
  score_id: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const SUMMARY_COLUMNS = `id, owner, status, audio_key, content_type, filename, size_bytes, instrument,
  declared_duration_seconds, attempts, diagnostic_kind, diagnostic, progress, duration_seconds, score_id,
  lease_expires_at, version, created_at, updated_at`;

export async function openPostgresAudioJobStore(options: PostgresAudioJobStoreOptions): Promise<AudioJobStore> {
  const handle = poolFor(options);
  const { pool } = handle;
  try {
    await assertRlsEnforced(pool, options.allowRlsBypass ?? false);
    await migratePostgres(pool);
  } catch (error) {
    await closeHandle(handle);
    throw error;
  }
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());

  return {
    async list(owner): Promise<AudioJobSummary[]> {
      return asOwner(pool, owner, async (client) => {
        const result = await client.query<AudioJobRow>(
          `SELECT ${SUMMARY_COLUMNS} FROM audio_jobs WHERE owner = $1 ORDER BY created_at DESC, id COLLATE "C" ASC`,
          [owner],
        );
        return result.rows.map(toSummary);
      });
    },

    async get(owner, id): Promise<AudioJob | null> {
      return asOwner(pool, owner, async (client) => {
        const result = await client.query<AudioJobRow>(`SELECT * FROM audio_jobs WHERE owner = $1 AND id = $2`, [owner, id]);
        return result.rows[0] === undefined ? null : toJob(result.rows[0]);
      });
    },

    async create(owner, job): Promise<AudioJob> {
      const at = timestamp(now);
      return asOwner(pool, owner, async (client) => {
        const result = await client.query<AudioJobRow>(
          `INSERT INTO audio_jobs
             (id, owner, status, audio_key, content_type, filename, size_bytes, instrument,
              declared_duration_seconds, attempts, version, created_at, updated_at)
           VALUES ($1, $2, 'awaiting-upload', $3, $4, $5, $6, $7, $8, 0, 1, $9, $9)
           RETURNING *`,
          [newId(), owner, job.audioKey, job.contentType, job.filename, job.sizeBytes, job.instrument, job.declaredDurationSeconds, at],
        );
        return toJob(result.rows[0]!);
      });
    },

    async markUploaded(owner, id, sizeBytes): Promise<AudioJob | null> {
      return asOwner(pool, owner, async (client) => {
        const result = await client.query<AudioJobRow>(
          `UPDATE audio_jobs SET status = 'queued', size_bytes = $1, version = version + 1, updated_at = $2
            WHERE owner = $3 AND id = $4 AND status = 'awaiting-upload' RETURNING *`,
          [sizeBytes, timestamp(now), owner, id],
        );
        return result.rows[0] === undefined ? null : toJob(result.rows[0]);
      });
    },

    async retry(owner, id): Promise<AudioJob | null> {
      return asOwner(pool, owner, async (client) => {
        const result = await client.query<AudioJobRow>(
          `UPDATE audio_jobs
              SET status = 'queued', attempts = 0, diagnostic = NULL, diagnostic_kind = NULL, progress = NULL,
                  version = version + 1, updated_at = $1
            WHERE owner = $2 AND id = $3 AND status = 'failed' RETURNING *`,
          [timestamp(now), owner, id],
        );
        return result.rows[0] === undefined ? null : toJob(result.rows[0]);
      });
    },

    async delete(owner, id): Promise<AudioJob | null> {
      return asOwner(pool, owner, async (client) => {
        const result = await client.query<AudioJobRow>(`DELETE FROM audio_jobs WHERE owner = $1 AND id = $2 RETURNING *`, [owner, id]);
        return result.rows[0] === undefined ? null : toJob(result.rows[0]);
      });
    },

    async claim(leaseSeconds): Promise<AudioJob | null> {
      const at = now();
      return asSystem(pool, async (client) => {
        // The oldest queued job to `running` in one statement; SKIP LOCKED lets several workers claim at
        // once without waiting on, or taking, one another's row (as `postgres-jobs.ts` does for imports).
        const result = await client.query<AudioJobRow>(
          `UPDATE audio_jobs
              SET status = 'running', attempts = attempts + 1, lease_token = $1, lease_expires_at = $2, progress = NULL,
                  version = version + 1, updated_at = $3
            WHERE id = (
              SELECT id FROM audio_jobs WHERE status = 'queued'
               ORDER BY created_at ASC, id COLLATE "C" ASC LIMIT 1 FOR UPDATE SKIP LOCKED
            )
            RETURNING *`,
          [randomUUID(), leaseUntil(at, leaseSeconds), stamp(at)],
        );
        return result.rows[0] === undefined ? null : toJob(result.rows[0]);
      });
    },

    async heartbeat(id, leaseToken, leaseSeconds, progress): Promise<LeaseOutcome> {
      const at = now();
      return asSystem(pool, async (client) => {
        const result = await client.query<AudioJobRow>(
          `UPDATE audio_jobs
              SET lease_expires_at = $1, progress = COALESCE($2, progress), version = version + 1, updated_at = $3
            WHERE id = $4 AND lease_token = $5 AND status = 'running' RETURNING *`,
          [leaseUntil(at, leaseSeconds), progress === null ? null : JSON.stringify(progress), stamp(at), id, leaseToken],
        );
        return result.rows[0] === undefined ? { outcome: 'lease-lost' } : { outcome: 'ok', job: toJob(result.rows[0]) };
      });
    },

    async complete(id, leaseToken, result, durationSeconds): Promise<LeaseOutcome> {
      return asSystem(pool, async (client) => {
        const updated = await client.query<AudioJobRow>(
          `UPDATE audio_jobs
              SET status = 'succeeded', result = $1, duration_seconds = $2, progress = NULL, diagnostic = NULL,
                  diagnostic_kind = NULL, version = version + 1, updated_at = $3
            WHERE id = $4 AND lease_token = $5 AND status = 'running' RETURNING *`,
          [JSON.stringify(result), durationSeconds, timestamp(now), id, leaseToken],
        );
        if (updated.rows[0] !== undefined) return { outcome: 'ok', job: toJob(updated.rows[0]) };
        const existing = (await client.query<AudioJobRow>(`SELECT * FROM audio_jobs WHERE id = $1`, [id])).rows[0];
        return existing !== undefined && existing.lease_token === leaseToken && existing.status === 'succeeded'
          ? { outcome: 'already', job: toJob(existing) }
          : { outcome: 'lease-lost' };
      });
    },

    async fail(id, leaseToken, failure): Promise<LeaseOutcome> {
      return asSystem(pool, async (client) => {
        const current = (await client.query<AudioJobRow>(`SELECT * FROM audio_jobs WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (current === undefined || current.lease_token !== leaseToken) return { outcome: 'lease-lost' };
        if (current.status !== 'running') {
          return current.status === 'failed' || current.status === 'queued'
            ? { outcome: 'already', job: toJob(current) }
            : { outcome: 'lease-lost' };
        }
        const requeue = failure.retryable && current.attempts < failure.maxAttempts;
        const updated = requeue
          ? await client.query<AudioJobRow>(
              `UPDATE audio_jobs SET status = 'queued', progress = NULL, version = version + 1, updated_at = $1
                WHERE id = $2 RETURNING *`,
              [timestamp(now), id],
            )
          : await client.query<AudioJobRow>(
              `UPDATE audio_jobs
                  SET status = 'failed', diagnostic_kind = $1, diagnostic = $2, progress = NULL, version = version + 1, updated_at = $3
                WHERE id = $4 RETURNING *`,
              [failure.kind, failure.message, timestamp(now), id],
            );
        return { outcome: 'ok', job: toJob(updated.rows[0]!) };
      });
    },

    async expireLeases(maxAttempts): Promise<{ requeued: AudioJob[]; failed: AudioJob[] }> {
      const at = timestamp(now);
      return asSystem(pool, async (client) => {
        const requeued = await client.query<AudioJobRow>(
          `UPDATE audio_jobs SET status = 'queued', progress = NULL, version = version + 1, updated_at = $1
            WHERE status = 'running' AND lease_expires_at < $1 AND attempts < $2 RETURNING *`,
          [at, maxAttempts],
        );
        const failed = await client.query<AudioJobRow>(
          `UPDATE audio_jobs
              SET status = 'failed', diagnostic_kind = 'worker-lost', diagnostic = 'the transcription worker stopped responding',
                  progress = NULL, version = version + 1, updated_at = $1
            WHERE status = 'running' AND lease_expires_at < $1 AND attempts >= $2 RETURNING *`,
          [at, maxAttempts],
        );
        return { requeued: requeued.rows.map(toJob), failed: failed.rows.map(toJob) };
      });
    },

    async getById(id): Promise<AudioJob | null> {
      return asSystem(pool, async (client) => {
        const result = await client.query<AudioJobRow>(`SELECT * FROM audio_jobs WHERE id = $1`, [id]);
        return result.rows[0] === undefined ? null : toJob(result.rows[0]);
      });
    },

    async attachScore(id, scoreId: Id, diagnostic = null): Promise<AudioJob | null> {
      return asSystem(pool, async (client) => {
        const result = await client.query<AudioJobRow>(
          `UPDATE audio_jobs SET score_id = $1, diagnostic = $2, version = version + 1, updated_at = $3 WHERE id = $4 RETURNING *`,
          [scoreId, diagnostic, timestamp(now), id],
        );
        return result.rows[0] === undefined ? null : toJob(result.rows[0]);
      });
    },

    async rejectResult(id, kind, message): Promise<AudioJob | null> {
      return asSystem(pool, async (client) => {
        const result = await client.query<AudioJobRow>(
          `UPDATE audio_jobs
              SET status = 'failed', diagnostic_kind = $1, diagnostic = $2, version = version + 1, updated_at = $3
            WHERE id = $4 AND status = 'succeeded' RETURNING *`,
          [kind, message, timestamp(now), id],
        );
        return result.rows[0] === undefined ? null : toJob(result.rows[0]);
      });
    },

    async recordUsage(owner, jobId, seconds): Promise<boolean> {
      return asSystem(pool, async (client) => {
        const result = await client.query(
          `INSERT INTO audio_usage (job_id, owner, seconds, recorded_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (job_id) DO NOTHING`,
          [jobId, owner, seconds, timestamp(now)],
        );
        return result.rowCount === 1;
      });
    },

    async usageSince(owner, sinceIso): Promise<{ seconds: number; jobs: number }> {
      return asOwner(pool, owner, async (client) => {
        const result = await client.query<{ seconds: number | null; jobs: string }>(
          `SELECT SUM(seconds) AS seconds, COUNT(*) AS jobs FROM audio_usage WHERE owner = $1 AND recorded_at >= $2`,
          [owner, sinceIso],
        );
        const row = result.rows[0]!;
        return { seconds: Number(row.seconds ?? 0), jobs: Number(row.jobs) };
      });
    },

    async close(): Promise<void> {
      await closeHandle(handle);
    },
  };
}

function toJob(row: AudioJobRow): AudioJob {
  return {
    ...toSummary(row),
    result: row.result === null ? null : (JSON.parse(row.result) as unknown),
    leaseToken: row.lease_token,
  };
}

function toSummary(row: Partial<AudioJobRow> & Omit<AudioJobRow, 'result' | 'lease_token'>): AudioJobSummary {
  return {
    id: row.id,
    owner: row.owner,
    status: row.status as AudioJob['status'],
    audioKey: row.audio_key,
    contentType: row.content_type,
    filename: row.filename,
    sizeBytes: Number(row.size_bytes),
    instrument: row.instrument,
    declaredDurationSeconds: row.declared_duration_seconds,
    attempts: row.attempts,
    diagnosticKind: row.diagnostic_kind,
    diagnostic: row.diagnostic,
    progress: row.progress === null ? null : (JSON.parse(row.progress) as AudioProgress),
    durationSeconds: row.duration_seconds,
    scoreId: row.score_id,
    leaseExpiresAt: row.lease_expires_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The lease deadline, in the same second-resolution text the rest of the table uses (compares as text). */
function leaseUntil(at: Date, seconds: number): string {
  return stamp(new Date(at.getTime() + seconds * 1000));
}

function stamp(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}
