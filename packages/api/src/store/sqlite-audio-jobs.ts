import SqliteDatabase from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { migrateTables } from './sqlite-schema.js';
import type { AudioJob, AudioJobId, AudioJobStore, AudioJobSummary, AudioProgress } from './audio-jobs.js';

/**
 * The SQLite implementation of the audio-job port (ADR-0006, SIB2-137): the sibling of
 * `sqlite-jobs.ts`, in its own file and on its own connection to the same database for the same
 * reason — a job is not a score. `audio_jobs` is created by `migrateTables` with the other tables.
 * One of the files `tests/arch/store-seam.test.ts` allows to know SQLite exists.
 */

export interface SqliteAudioJobStoreOptions {
  /** `:memory:` for a test, a filesystem path for the real thing — the same file as the score store. */
  filename: string;
  now?: () => Date;
  newId?: () => AudioJobId;
}

export interface AudioJobRow {
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

export function openSqliteAudioJobStore(options: SqliteAudioJobStoreOptions): AudioJobStore {
  const db: Database = new SqliteDatabase(options.filename);
  migrateTables(db);
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());

  const statements = {
    list: db.prepare<[string], AudioJobRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM audio_jobs WHERE owner = ? ORDER BY created_at DESC, id ASC`,
    ),
    get: db.prepare<[string, string], AudioJobRow>(`SELECT * FROM audio_jobs WHERE owner = ? AND id = ?`),
    byId: db.prepare<[string], AudioJobRow>(`SELECT * FROM audio_jobs WHERE id = ?`),
    insert: db.prepare(
      `INSERT INTO audio_jobs
         (id, owner, status, audio_key, content_type, filename, size_bytes, instrument,
          declared_duration_seconds, attempts, version, created_at, updated_at)
       VALUES (@id, @owner, 'awaiting-upload', @audio_key, @content_type, @filename, @size_bytes, @instrument,
          @declared, 0, 1, @at, @at)`,
    ),
    markUploaded: db.prepare<[number, string, string, string], AudioJobRow>(
      `UPDATE audio_jobs SET status = 'queued', size_bytes = ?, version = version + 1, updated_at = ?
        WHERE owner = ? AND id = ? AND status = 'awaiting-upload' RETURNING *`,
    ),
    retry: db.prepare<[string, string, string], AudioJobRow>(
      `UPDATE audio_jobs
          SET status = 'queued', attempts = 0, diagnostic = NULL, diagnostic_kind = NULL, progress = NULL,
              version = version + 1, updated_at = ?
        WHERE owner = ? AND id = ? AND status = 'failed' RETURNING *`,
    ),
    delete: db.prepare<[string, string], AudioJobRow>(`DELETE FROM audio_jobs WHERE owner = ? AND id = ? RETURNING *`),
    deleteUsage: db.prepare<[string]>(`DELETE FROM audio_usage WHERE owner = ?`),
    deleteAll: db.prepare<[string], { id: string; audio_key: string }>(`DELETE FROM audio_jobs WHERE owner = ? RETURNING id, audio_key`),

    // The ledger (SIB2-139). INSERT OR IGNORE on the job id is the idempotency.
    recordUsage: db.prepare<[string, string, number, string]>(
      `INSERT OR IGNORE INTO audio_usage (job_id, owner, seconds, recorded_at) VALUES (?, ?, ?, ?)`,
    ),
    usageSince: db.prepare<[string, string], { seconds: number | null; jobs: number }>(
      `SELECT SUM(seconds) AS seconds, COUNT(*) AS jobs FROM audio_usage WHERE owner = ? AND recorded_at >= ?`,
    ),

    // The worker half (SIB2-138). Not owner-scoped.
    claim: db.prepare<[string, string, string], AudioJobRow>(
      // One conditional UPDATE with a subquery, as the import queue's claim is: oldest queued job to
      // `running` in a single statement, so even several processes cannot take one twice.
      `UPDATE audio_jobs
          SET status = 'running', attempts = attempts + 1, lease_token = ?, lease_expires_at = ?, progress = NULL,
              version = version + 1, updated_at = ?
        WHERE id = (SELECT id FROM audio_jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1)
      RETURNING *`,
    ),
    heartbeat: db.prepare<[string, string | null, string, string, string], AudioJobRow>(
      `UPDATE audio_jobs
          SET lease_expires_at = ?, progress = COALESCE(?, progress), version = version + 1, updated_at = ?
        WHERE id = ? AND lease_token = ? AND status = 'running' RETURNING *`,
    ),
    complete: db.prepare<[string, number, string, string, string], AudioJobRow>(
      `UPDATE audio_jobs
          SET status = 'succeeded', result = ?, duration_seconds = ?, progress = NULL, diagnostic = NULL,
              diagnostic_kind = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND lease_token = ? AND status = 'running' RETURNING *`,
    ),
    failTerminal: db.prepare<[string, string, string, string, string], AudioJobRow>(
      `UPDATE audio_jobs
          SET status = 'failed', diagnostic_kind = ?, diagnostic = ?, progress = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND lease_token = ? AND status = 'running' RETURNING *`,
    ),
    failRequeue: db.prepare<[string, string, string], AudioJobRow>(
      `UPDATE audio_jobs SET status = 'queued', progress = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND lease_token = ? AND status = 'running' RETURNING *`,
    ),
    expireRequeue: db.prepare<[string, string, number], AudioJobRow>(
      `UPDATE audio_jobs SET status = 'queued', progress = NULL, version = version + 1, updated_at = ?
        WHERE status = 'running' AND lease_expires_at < ? AND attempts < ? RETURNING *`,
    ),
    expireFail: db.prepare<[string, string, string, string, number], AudioJobRow>(
      `UPDATE audio_jobs
          SET status = 'failed', diagnostic_kind = ?, diagnostic = ?, progress = NULL, version = version + 1, updated_at = ?
        WHERE status = 'running' AND lease_expires_at < ? AND attempts >= ? RETURNING *`,
    ),
    attachScore: db.prepare<[string, string, string], AudioJobRow>(
      `UPDATE audio_jobs SET score_id = ?, version = version + 1, updated_at = ? WHERE id = ? RETURNING *`,
    ),
    rejectResult: db.prepare<[string, string, string, string], AudioJobRow>(
      `UPDATE audio_jobs
          SET status = 'failed', diagnostic_kind = ?, diagnostic = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'succeeded' RETURNING *`,
    ),
  };

  return {
    async list(owner) {
      return statements.list.all(owner).map(toAudioSummary);
    },
    async get(owner, id) {
      const row = statements.get.get(owner, id);
      return row === undefined ? null : toAudioJob(row);
    },
    async create(owner, job) {
      const id = newId();
      statements.insert.run({
        id,
        owner,
        audio_key: job.audioKey,
        content_type: job.contentType,
        filename: job.filename,
        size_bytes: job.sizeBytes,
        instrument: job.instrument,
        declared: job.declaredDurationSeconds,
        at: timestamp(now),
      });
      return toAudioJob(statements.byId.get(id)!);
    },
    async markUploaded(owner, id, sizeBytes) {
      const row = statements.markUploaded.get(sizeBytes, timestamp(now), owner, id);
      return row === undefined ? null : toAudioJob(row);
    },
    async retry(owner, id) {
      const row = statements.retry.get(timestamp(now), owner, id);
      return row === undefined ? null : toAudioJob(row);
    },
    async delete(owner, id) {
      const row = statements.delete.get(owner, id);
      return row === undefined ? null : toAudioJob(row);
    },
    async deleteAll(owner) {
      // The metering ledger is the account's too: nothing addressed by its id may outlive it (V25).
      statements.deleteUsage.run(owner);
      return statements.deleteAll.all(owner).map((row) => ({ id: row.id, audioKey: row.audio_key }));
    },
    async claim(leaseSeconds) {
      const at = now();
      const row = statements.claim.get(randomUUID(), leaseUntil(at, leaseSeconds), stamp(at));
      return row === undefined ? null : toAudioJob(row);
    },
    async heartbeat(id, leaseToken, leaseSeconds, progress) {
      const at = now();
      const row = statements.heartbeat.get(
        leaseUntil(at, leaseSeconds),
        progress === null ? null : JSON.stringify(progress),
        stamp(at),
        id,
        leaseToken,
      );
      return row === undefined ? { outcome: 'lease-lost' } : { outcome: 'ok', job: toAudioJob(row) };
    },
    async complete(id, leaseToken, result, durationSeconds) {
      const row = statements.complete.get(JSON.stringify(result), durationSeconds, timestamp(now), id, leaseToken);
      if (row !== undefined) return { outcome: 'ok', job: toAudioJob(row) };
      const existing = statements.byId.get(id);
      return existing !== undefined && existing.lease_token === leaseToken && existing.status === 'succeeded'
        ? { outcome: 'already', job: toAudioJob(existing) }
        : { outcome: 'lease-lost' };
    },
    async fail(id, leaseToken, failure) {
      const current = statements.byId.get(id);
      if (current === undefined || current.lease_token !== leaseToken) return { outcome: 'lease-lost' };
      if (current.status !== 'running') {
        // The same lease already ended this attempt: a repeat is the same answer.
        return current.status === 'failed' || current.status === 'queued'
          ? { outcome: 'already', job: toAudioJob(current) }
          : { outcome: 'lease-lost' };
      }
      const requeue = failure.retryable && current.attempts < failure.maxAttempts;
      const row = requeue
        ? statements.failRequeue.get(timestamp(now), id, leaseToken)
        : statements.failTerminal.get(failure.kind, failure.message, timestamp(now), id, leaseToken);
      return row === undefined ? { outcome: 'lease-lost' } : { outcome: 'ok', job: toAudioJob(row) };
    },
    async expireLeases(maxAttempts) {
      const at = timestamp(now);
      const requeued = statements.expireRequeue.all(at, at, maxAttempts).map(toAudioJob);
      const failed = statements.expireFail
        .all('worker-lost', 'the transcription worker stopped responding', at, at, maxAttempts)
        .map(toAudioJob);
      return { requeued, failed };
    },
    async getById(id) {
      const row = statements.byId.get(id);
      return row === undefined ? null : toAudioJob(row);
    },
    async attachScore(id, scoreId) {
      const row = statements.attachScore.get(scoreId, timestamp(now), id);
      return row === undefined ? null : toAudioJob(row);
    },
    async rejectResult(id, kind, message) {
      const row = statements.rejectResult.get(kind, message, timestamp(now), id);
      return row === undefined ? null : toAudioJob(row);
    },
    async recordUsage(owner, jobId, seconds) {
      return statements.recordUsage.run(jobId, owner, seconds, timestamp(now)).changes === 1;
    },
    async usageSince(owner, sinceIso) {
      const row = statements.usageSince.get(owner, sinceIso)!;
      return { seconds: row.seconds ?? 0, jobs: row.jobs };
    },
    async close() {
      db.close();
    },
  };
}

/** Shared with the Postgres adapter's shape, but not its code: each adapter owns its row type. */
export function toAudioJob(row: AudioJobRow): AudioJob {
  return {
    ...toAudioSummary(row),
    result: row.result === null ? null : (JSON.parse(row.result) as unknown),
    leaseToken: row.lease_token,
  };
}

function toAudioSummary(row: Omit<AudioJobRow, 'result' | 'lease_token'> & Partial<AudioJobRow>): AudioJobSummary {
  return {
    id: row.id,
    owner: row.owner,
    status: row.status as AudioJob['status'],
    audioKey: row.audio_key,
    contentType: row.content_type,
    filename: row.filename,
    sizeBytes: row.size_bytes,
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

/** ISO-8601 to the second. Sortable as text, which is what the listing index relies on. */
function timestamp(now: () => Date): string {
  return `${now().toISOString().slice(0, 19)}Z`;
}
