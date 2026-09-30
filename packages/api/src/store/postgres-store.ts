import { migrateDocument } from '@sibei/model';
import type { Id, MigrationResult, Score } from '@sibei/model';
import type { Pool, PoolClient, PoolConfig } from 'pg';
import type { StoredOperation } from '../ops/operations.js';
import { assertRlsEnforced, migratePostgres } from './postgres-schema.js';
import { asOwner, closeHandle, poolFor } from './postgres-session.js';
import type { Owner, ScoreListing, ScoreRecord, ScoreStore, WriteOutcome } from './repository.js';
import { assertCarriesOperations, listingColumns, timestamp, toListing, toStoredOperation } from './store-shared.js';
import type { ListingRow, OperationRow } from './store-shared.js';

/**
 * The Postgres implementation of the store port (V19, ADR-0006, ADR-0034).
 *
 * One of the four files that may know Postgres exists (`tests/arch/store-seam.test.ts`); the sibling of
 * `sqlite-store.ts`, and held to the same contract by one conformance suite that runs against both
 * (`tests/store/conformance.ts`). Where they differ it is in mechanism, never in what a caller sees:
 *
 *   - **Every call is a transaction that first names the owner** (`postgres-session.ts`), so row-level
 *     security binds it. The `WHERE owner = …` clauses below are kept anyway — they are what makes a
 *     query use its index and read as correct — and RLS is what makes a missed one harmless.
 *   - **A stale write is decided by the row lock, not by a check-then-write.** `commit`'s `UPDATE …
 *     WHERE version = $expected` blocks behind a concurrent writer on the same row, re-evaluates the
 *     condition once that writer commits, and matches nothing — so two writers at one version cannot
 *     both win (ADR-0003), with no application-level lock. The log's next `seq` is read inside the same
 *     transaction *after* that lock is held, which is what serialises it per score.
 *   - **An id collision is answered by `ON CONFLICT DO NOTHING`,** not by catching a unique violation:
 *     in Postgres an error aborts the whole transaction, so the check and the write must be one
 *     statement rather than a try/catch around one.
 */

export interface PostgresStoreOptions {
  /** A `postgres://…` URL. The adapter makes (and, on `close`, ends) its own pool from it. */
  connectionString?: string;
  /** A pool lent by the caller, shared with the job store. The caller closes it. */
  pool?: Pool;
  /** Extra `pg` pool settings (size, timeouts) when the adapter makes the pool. */
  poolConfig?: PoolConfig;
  /**
   * Told when the server drops an idle connection (restart, failover, timeout). The pool recovers on its
   * own; this is only where the event is reported. Defaults to a one-line `console.error`.
   */
  onError?: (error: Error) => void;
  /** Injected so a test can assert on the timestamp rather than tolerate it. */
  now?: () => Date;
  /** How to bring a stored document up to the current schema version (ADR-0028); injected as in SQLite. */
  migrate?: (raw: unknown) => MigrationResult;
  /**
   * Run even as a superuser or a `BYPASSRLS` role, which row-level security does not bind. Off by
   * default because it silently disables the backstop; for local development only (see
   * `assertRlsEnforced`).
   */
  allowRlsBypass?: boolean;
}

interface ScoreRow extends ListingRow {
  owner: string;
  doc: string;
}

export async function openPostgresStore(options: PostgresStoreOptions): Promise<ScoreStore> {
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
  const migrate = options.migrate ?? migrateDocument;

  /**
   * Append a batch of operations as one undoable unit (ADR-0003). Sequence numbers are gapless per score
   * and assigned here rather than by the caller, so the log's order is the store's to guarantee. The
   * caller already holds the score row's lock (an UPDATE, or the INSERT that just created it), so two
   * appends to one score cannot interleave.
   */
  async function appendOperations(
    client: PoolClient,
    owner: Owner,
    scoreId: Id,
    operations: readonly StoredOperation[],
  ): Promise<void> {
    const cursor = await client.query<{ next_seq: number; next_batch: number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq, COALESCE(MAX(batch), 0) + 1 AS next_batch
         FROM operations WHERE owner = $1 AND score_id = $2`,
      [owner, scoreId],
    );
    const first = cursor.rows[0] ?? { next_seq: 1, next_batch: 1 };
    for (const [offset, operation] of operations.entries()) {
      await client.query(
        `INSERT INTO operations (owner, score_id, seq, batch, op_version, type, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          owner,
          scoreId,
          first.next_seq + offset,
          first.next_batch,
          operation.version,
          operation.operation.type,
          JSON.stringify(operation.operation),
          operation.createdAt,
        ],
      );
    }
  }

  return {
    async list(owner): Promise<ScoreListing[]> {
      return asOwner(pool, owner, async (client) => {
        const result = await client.query<ListingRow>(
          `SELECT id, title, composer, key, updated_at, version
             FROM scores WHERE owner = $1
            ORDER BY updated_at DESC, id COLLATE "C" ASC`,
          [owner],
        );
        return result.rows.map(toListing);
      });
    },

    async get(owner, id): Promise<ScoreRecord | null> {
      return asOwner(pool, owner, async (client) => {
        const result = await client.query<ScoreRow>(`SELECT * FROM scores WHERE owner = $1 AND id = $2`, [owner, id]);
        const row = result.rows[0];
        if (row === undefined) return null;

        // Migrate on read (ADR-0028). A document this build cannot understand throws
        // DocumentMigrationError rather than being read on a best-effort basis.
        const migrated = migrate(JSON.parse(row.doc));
        if (migrated.migrated) {
          // The write-back, and the reason it is its own statement: `version` is absent from the SET
          // clause. A migration is not an edit, and bumping it would spuriously invalidate a client's
          // expectedVersion. Guarded on the version we read, so it cannot clobber a newer write.
          const columns = listingColumns(migrated.score);
          await client.query(
            `UPDATE scores SET doc = $1, title = $2, composer = $3, key = $4
              WHERE owner = $5 AND id = $6 AND version = $7`,
            [JSON.stringify(migrated.score), columns.title, columns.composer, columns.key, owner, id, row.version],
          );
        }
        return { score: migrated.score, version: row.version, updatedAt: row.updated_at };
      });
    },

    async exists(owner, id): Promise<boolean> {
      return asOwner(pool, owner, async (client) => {
        const result = await client.query(`SELECT 1 FROM scores WHERE owner = $1 AND id = $2`, [owner, id]);
        return result.rowCount === 1;
      });
    },

    async operations(owner, id): Promise<StoredOperation[]> {
      return asOwner(pool, owner, async (client) => {
        const result = await client.query<OperationRow>(
          `SELECT seq, batch, op_version, payload, created_at
             FROM operations WHERE owner = $1 AND score_id = $2 ORDER BY seq ASC`,
          [owner, id],
        );
        return result.rows.map(toStoredOperation);
      });
    },

    async create(owner, score, operations): Promise<WriteOutcome> {
      assertCarriesOperations(operations);
      return asOwner(pool, owner, async (client) => {
        const updatedAt = timestamp(now);
        const columns = listingColumns(score);
        const inserted = await client.query(
          `INSERT INTO scores (owner, id, title, composer, key, updated_at, version, doc)
           VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
           ON CONFLICT (owner, id) DO NOTHING`,
          [owner, score.id, columns.title, columns.composer, columns.key, updatedAt, JSON.stringify(score)],
        );
        // Let the primary key answer, in the same statement as the write, so the check and the write
        // cannot come apart. An id collision means a bug upstream, not a user error.
        if (inserted.rowCount === 0) return { ok: false, reason: 'already-exists' } as const;
        await appendOperations(client, owner, score.id, operations);
        return { ok: true, version: 1, updatedAt } as const;
      });
    },

    async commit(owner, id, expectedVersion, score, operations): Promise<WriteOutcome> {
      assertCarriesOperations(operations);
      return asOwner(pool, owner, async (client) => {
        const updatedAt = timestamp(now);
        const columns = listingColumns(score);
        const updated = await client.query(
          `UPDATE scores
              SET title = $1, composer = $2, key = $3, updated_at = $4, version = version + 1, doc = $5
            WHERE owner = $6 AND id = $7 AND version = $8`,
          [columns.title, columns.composer, columns.key, updatedAt, JSON.stringify(score), owner, id, expectedVersion],
        );

        if (updated.rowCount === 1) {
          // Inside the same transaction as the version check, so a document can never be written
          // without the operations that caused it, and vice versa.
          await appendOperations(client, owner, id, operations);
          return { ok: true, version: expectedVersion + 1, updatedAt } as const;
        }

        // The statement matched nothing, so either the score is gone or the version moved. Reading the
        // row tells the client which, and gives it the version to retry at.
        const row = await client.query<{ version: number }>(
          `SELECT version FROM scores WHERE owner = $1 AND id = $2`,
          [owner, id],
        );
        const current = row.rows[0];
        if (current === undefined) return { ok: false, reason: 'not-found' } as const;
        return { ok: false, reason: 'conflict', version: current.version } as const;
      });
    },

    async delete(owner, id): Promise<boolean> {
      return asOwner(pool, owner, async (client) => {
        const result = await client.query(`DELETE FROM scores WHERE owner = $1 AND id = $2`, [owner, id]);
        return result.rowCount === 1;
      });
    },

    async close(): Promise<void> {
      await closeHandle(handle);
    },
  };
}
