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

/** ISO-8601 to the second. Sortable as text, which is what the listing index relies on. */
function timestamp(now: () => Date): string {
  return `${now().toISOString().slice(0, 19)}Z`;
}
