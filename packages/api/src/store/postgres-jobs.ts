import { randomUUID } from 'node:crypto';
import type { Id, OmrDocument } from '@sibei/model';
import type { Pool, PoolConfig } from 'pg';
import type { BlobKey } from '../blob/blob-store.js';
import type { ImportJob, ImportJobSummary, JobId, JobStore } from './jobs.js';
import { assertRlsEnforced, migratePostgres } from './postgres-schema.js';
import { asOwner, asSystem, closeHandle, poolFor } from './postgres-session.js';
import type { Owner } from './repository.js';
import { timestamp } from './store-shared.js';

/**
 * The Postgres implementation of the job port (V19, ADR-0034), the durable half of "OMR is a job, not a
 * request" (ADR-0001) and the sibling of `sqlite-jobs.ts`.
 *
 * One of the four files that may know Postgres exists (`tests/arch/store-seam.test.ts`). Held to the
 * same contract as the SQLite adapter by the shared conformance suite. Two things are Postgres's own:
 *
 *   - **The claim is `FOR UPDATE SKIP LOCKED`.** SQLite's single conditional UPDATE was enough because
 *     one process serialises every statement. With a worker pool over a real network, two runners
 *     claiming at once must each get a *different* job and neither may wait on the other's lock, which is
 *     what SKIP LOCKED is for. `tests/postgres/` races many claimers to prove it.
 *   - **The four methods that are not owner-scoped run as the system actor** (`asSystem`): `claim`,
 *     `complete`, `fail` and `recover`. Everything a request can reach is owner-scoped, so a missed
 *     filter in a route still cannot read or move another owner's job (`postgres-schema.ts`).
 */

export interface PostgresJobStoreOptions {
  /** A `postgres://…` URL. The adapter makes (and, on `close`, ends) its own pool from it. */
  connectionString?: string;
  /** A pool lent by the caller, shared with the score store. The caller closes it. */
  pool?: Pool;
  /** Extra `pg` pool settings when the adapter makes the pool. */
  poolConfig?: PoolConfig;
  /**
   * Told when the server drops an idle connection (restart, failover, timeout). The pool recovers on its
   * own; this is only where the event is reported. Defaults to a one-line `console.error`.
   */
  onError?: (error: Error) => void;
  /** Injected so a test can assert on the timestamp rather than tolerate it. */
  now?: () => Date;
  /** Injected so a test gets deterministic ids. */
  newId?: () => JobId;
  /** See `PostgresStoreOptions.allowRlsBypass`. */
  allowRlsBypass?: boolean;
}

interface JobRow {
  id: string;
  owner: string;
  status: string;
  image_keys: string;
  engine: string | null;
  attempts: number;
  diagnostic: string | null;
  result: string | null;
  score_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

type SummaryRow = Omit<JobRow, 'result'>;

export async function openPostgresJobStore(options: PostgresJobStoreOptions): Promise<JobStore> {
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
    async list(owner): Promise<ImportJobSummary[]> {
      return asOwner(pool, owner, async (client) => {
        const result = await client.query<SummaryRow>(
          `SELECT id, owner, status, image_keys, engine, attempts, diagnostic, score_id, version, created_at, updated_at
             FROM import_jobs WHERE owner = $1 ORDER BY created_at DESC, id COLLATE "C" ASC`,
          [owner],
        );
        return result.rows.map(toSummary);
      });
    },

    async get(owner, id): Promise<ImportJob | null> {
      return asOwner(pool, owner, async (client) => {
        const result = await client.query<JobRow>(`SELECT * FROM import_jobs WHERE owner = $1 AND id = $2`, [owner, id]);
        return result.rows[0] === undefined ? null : toJob(result.rows[0]);
      });
    },

    async getByScoreId(owner, scoreId: Id): Promise<ImportJob | null> {
      return asOwner(pool, owner, async (client) => {
        // At most one row matches: only a succeeded job has a non-null score_id, and a score is produced
        // by a single import (V14). LIMIT 1 makes that a fact of the query, not an assumption.
        const result = await client.query<JobRow>(
          `SELECT * FROM import_jobs WHERE owner = $1 AND score_id = $2 LIMIT 1`,
          [owner, scoreId],
        );
        return result.rows[0] === undefined ? null : toJob(result.rows[0]);
      });
    },

    async create(owner, imageKeys: BlobKey[], engine: string | null = null): Promise<ImportJob> {
      if (imageKeys.length === 0) throw new Error('an import job must carry at least one image');
      const createdAt = timestamp(now);
      return asOwner(pool, owner, async (client) => {
        // RETURNING rather than reconstruct, so the row is the store's truth and not this function's
        // guess at it.
        const result = await client.query<JobRow>(
          `INSERT INTO import_jobs
             (id, owner, status, image_keys, engine, attempts, diagnostic, result, score_id, version, created_at, updated_at)
           VALUES ($1, $2, 'queued', $3, $4, 0, NULL, NULL, NULL, 1, $5, $5)
           RETURNING *`,
          [newId(), owner, JSON.stringify(imageKeys), engine, createdAt],
        );
        return toJob(result.rows[0]!);
      });
    },

    async claim(): Promise<ImportJob | null> {
      return asSystem(pool, async (client) => {
        // Pick the oldest queued job and move it to `running` in one statement. SKIP LOCKED is what lets
        // several runners claim concurrently: a job another runner has locked is passed over rather than
        // waited for, so no two runners ever take the same one and none stalls behind another.
        const result = await client.query<JobRow>(
          `UPDATE import_jobs
              SET status = 'running', attempts = attempts + 1, version = version + 1, updated_at = $1
            WHERE id = (
              SELECT id FROM import_jobs WHERE status = 'queued'
               ORDER BY created_at ASC, id COLLATE "C" ASC LIMIT 1 FOR UPDATE SKIP LOCKED
            )
            RETURNING *`,
          [timestamp(now)],
        );
        return result.rows[0] === undefined ? null : toJob(result.rows[0]);
      });
    },

    async complete(id, result: OmrDocument[], scoreId): Promise<ImportJob | null> {
      return asSystem(pool, async (client) => {
        const updated = await client.query<JobRow>(
          `UPDATE import_jobs
              SET status = 'succeeded', result = $1, score_id = $2, diagnostic = NULL, version = version + 1, updated_at = $3
            WHERE id = $4 AND status = 'running'
            RETURNING *`,
          [JSON.stringify(result), scoreId, timestamp(now), id],
        );
        return updated.rows[0] === undefined ? null : toJob(updated.rows[0]);
      });
    },

    async fail(id, diagnostic): Promise<ImportJob | null> {
      return asSystem(pool, async (client) => {
        const updated = await client.query<JobRow>(
          `UPDATE import_jobs
              SET status = 'failed', diagnostic = $1, version = version + 1, updated_at = $2
            WHERE id = $3 AND status = 'running'
            RETURNING *`,
          [diagnostic, timestamp(now), id],
        );
        return updated.rows[0] === undefined ? null : toJob(updated.rows[0]);
      });
    },

    async retry(owner, id): Promise<ImportJob | null> {
      return asOwner(pool, owner, async (client) => {
        const updated = await client.query<JobRow>(
          `UPDATE import_jobs
              SET status = 'queued', diagnostic = NULL, version = version + 1, updated_at = $1
            WHERE owner = $2 AND id = $3 AND status = 'failed'
            RETURNING *`,
          [timestamp(now), owner, id],
        );
        return updated.rows[0] === undefined ? null : toJob(updated.rows[0]);
      });
    },

    async recover(diagnostic): Promise<number> {
      return asSystem(pool, async (client) => {
        const updated = await client.query(
          `UPDATE import_jobs
              SET status = 'failed', diagnostic = $1, version = version + 1, updated_at = $2
            WHERE status = 'running'`,
          [diagnostic, timestamp(now)],
        );
        return updated.rowCount ?? 0;
      });
    },

    async close(): Promise<void> {
      await closeHandle(handle);
    },
  };
}

function toJob(row: JobRow): ImportJob {
  return {
    id: row.id,
    owner: row.owner,
    status: row.status as ImportJob['status'],
    imageKeys: JSON.parse(row.image_keys) as BlobKey[],
    engine: row.engine,
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
    engine: row.engine,
    attempts: row.attempts,
    diagnostic: row.diagnostic,
    scoreId: row.score_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
