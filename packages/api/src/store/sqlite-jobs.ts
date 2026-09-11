import SqliteDatabase from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { OmrDocument } from '@sibei/model';
import { migrateTables } from './sqlite-schema.js';
import type { BlobKey } from '../blob/blob-store.js';
import type { Owner } from './repository.js';
import type { ImportJob, ImportJobSummary, JobId, JobStore } from './jobs.js';

/**
 * The SQLite implementation of the job port (ADR-0006), the durable half of "OMR is a job, not a
 * request" (ADR-0001).
 *
 * **This is the third — and, the seam test insists, deliberately argued-for — file in the product
 * that knows SQLite exists**, alongside `sqlite-store.ts` and `sqlite-schema.ts`. It is a separate
 * file, and a separate connection to the same database, rather than more methods on
 * `openSqliteStore`, because a job is not a score: the score store is the append-only op log and its
 * single writer (ADR-0003), and folding a mutable status column into it would blur exactly the line
 * that file exists to hold. The two connections never contend — better-sqlite3 is synchronous, so a
 * single Node process serialises every statement — and WAL (set by `migrateTables`) lets them share
 * the file cleanly. `tests/arch/store-seam.test.ts` names this file in its allowlist.
 *
 * The `import_jobs` DDL lives in `sqlite-schema.ts` with the other tables, so there is one migration
 * path and one `TABLE_SCHEMA_VERSION`; this adapter just calls `migrateTables` (idempotent) so it
 * works even if it is the first thing to open a fresh database.
 */

export interface SqliteJobStoreOptions {
  /** `:memory:` for a test, a filesystem path for the real thing — the same file as the score store. */
  filename: string;
  /** Injected so a test can assert on the timestamp rather than tolerate it. */
  now?: () => Date;
  /** Injected so a test gets deterministic ids. */
  newId?: () => JobId;
}

interface JobRow {
  id: string;
  owner: string;
  status: string;
  image_keys: string;
  attempts: number;
  diagnostic: string | null;
  result: string | null;
  score_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

type SummaryRow = Omit<JobRow, 'result'>;

export function openSqliteJobStore(options: SqliteJobStoreOptions): JobStore {
  const db: Database = new SqliteDatabase(options.filename);
  migrateTables(db);
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());

  const statements = {
    list: db.prepare<[Owner], SummaryRow>(
      `SELECT id, owner, status, image_keys, attempts, diagnostic, score_id, version, created_at, updated_at
         FROM import_jobs WHERE owner = ? ORDER BY created_at DESC, id ASC`,
    ),
    get: db.prepare<[Owner, JobId], JobRow>(
      `SELECT * FROM import_jobs WHERE owner = ? AND id = ?`,
    ),
    byId: db.prepare<[JobId], JobRow>(`SELECT * FROM import_jobs WHERE id = ?`),
    insert: db.prepare(
      `INSERT INTO import_jobs
         (id, owner, status, image_keys, attempts, diagnostic, result, score_id, version, created_at, updated_at)
       VALUES (@id, @owner, 'queued', @image_keys, 0, NULL, NULL, NULL, 1, @created_at, @created_at)`,
    ),
    /**
     * The claim, as one conditional UPDATE with a subquery: pick the oldest queued job and move it
     * to `running` in a single statement, so even a future multi-process pool cannot take one job
     * twice. `RETURNING` hands back the row the same statement wrote.
     */
    claim: db.prepare<[string], JobRow>(
      `UPDATE import_jobs
          SET status = 'running', attempts = attempts + 1, version = version + 1, updated_at = ?
        WHERE id = (
          SELECT id FROM import_jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1
        )
      RETURNING *`,
    ),
    complete: db.prepare<[string, string, string, JobId], JobRow>(
      `UPDATE import_jobs
          SET status = 'succeeded', result = ?, score_id = ?, diagnostic = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'running'
      RETURNING *`,
    ),
    fail: db.prepare<[string, string, JobId], JobRow>(
      `UPDATE import_jobs
          SET status = 'failed', diagnostic = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = 'running'
      RETURNING *`,
    ),
    retry: db.prepare<[string, Owner, JobId], JobRow>(
      `UPDATE import_jobs
          SET status = 'queued', diagnostic = NULL, version = version + 1, updated_at = ?
        WHERE owner = ? AND id = ? AND status = 'failed'
      RETURNING *`,
    ),
    recover: db.prepare<[string, string]>(
      `UPDATE import_jobs
          SET status = 'failed', diagnostic = ?, version = version + 1, updated_at = ?
        WHERE status = 'running'`,
    ),
  };

  return {
    list(owner) {
      return statements.list.all(owner).map(toSummary);
    },

    get(owner, id) {
      const row = statements.get.get(owner, id);
      return row === undefined ? null : toJob(row);
    },

    create(owner, imageKeys: BlobKey[]) {
      if (imageKeys.length === 0) throw new Error('an import job must carry at least one image');
      const id = newId();
      statements.insert.run({
        id,
        owner,
        image_keys: JSON.stringify(imageKeys),
        created_at: timestamp(now),
      });
      // Read it back rather than reconstruct it, so the row is the store's truth and not this
      // function's guess at it — the same reason `create` returns the stored score elsewhere.
      return toJob(statements.byId.get(id)!);
    },

    claim() {
      const row = statements.claim.get(timestamp(now));
      return row === undefined ? null : toJob(row);
    },

    complete(id, result: OmrDocument[], scoreId) {
      const row = statements.complete.get(JSON.stringify(result), scoreId, timestamp(now), id);
      return row === undefined ? null : toJob(row);
    },

    fail(id, diagnostic) {
      const row = statements.fail.get(diagnostic, timestamp(now), id);
      return row === undefined ? null : toJob(row);
    },

    retry(owner, id) {
      const row = statements.retry.get(timestamp(now), owner, id);
      return row === undefined ? null : toJob(row);
    },

    recover(diagnostic) {
      return statements.recover.run(diagnostic, timestamp(now)).changes;
    },

    close() {
      db.close();
    },
  };
}

function toJob(row: JobRow): ImportJob {
  return {
    id: row.id,
    owner: row.owner,
    status: row.status as ImportJob['status'],
    imageKeys: JSON.parse(row.image_keys) as BlobKey[],
    attempts: row.attempts,
    diagnostic: row.diagnostic,
    result: row.result === null ? null : (JSON.parse(row.result) as OmrDocument[]),
    scoreId: row.score_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSummary(row: SummaryRow): ImportJobSummary {
  return {
    id: row.id,
    owner: row.owner,
    status: row.status as ImportJob['status'],
    imageKeys: JSON.parse(row.image_keys) as BlobKey[],
    attempts: row.attempts,
    diagnostic: row.diagnostic,
    scoreId: row.score_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** ISO-8601 to the second. Sortable as text, which is what the listing index relies on. */
function timestamp(now: () => Date): string {
  return `${now().toISOString().slice(0, 19)}Z`;
}
