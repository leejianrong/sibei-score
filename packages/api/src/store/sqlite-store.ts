import SqliteDatabase from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { migrateDocument } from '@sibei/model';
import type { Id, MigrationResult, Score } from '@sibei/model';
import { migrateTables } from './sqlite-schema.js';
import type { StoredOperation } from '../ops/operations.js';
import type { Owner, ScoreRecord, ScoreStore } from './repository.js';
import { assertCarriesOperations, listingColumns, timestamp, toListing, toStoredOperation } from './store-shared.js';
import type { ListingRow, OperationRow } from './store-shared.js';

/**
 * The SQLite implementation of the store port (ADR-0006).
 *
 * **This is the only file in the product that knows SQLite exists.** `tests/arch` asserts it,
 * because the entire argument for the port was that the hosted transition is a change of
 * implementation and not a rewrite. If a route handler or the applier ever reaches a
 * statement directly, that argument is gone and nobody notices until the migration.
 *
 * better-sqlite3 over `node:sqlite`: the built-in is stable only from Node 24 and this
 * package's engines floor is 22. Behind the port either is a one-file change.
 */

/** `:memory:` for a test, a filesystem path for the real thing. */
export interface SqliteStoreOptions {
  filename: string;
  /** Injected so a test can assert on the timestamp rather than tolerate it. */
  now?: () => Date;
  /**
   * How to bring a stored document up to the current schema version. Defaults to the real
   * chain (ADR-0028); injected so the write-back path can be exercised against a synthetic
   * one while `DOCUMENT_MIGRATIONS` is still empty.
   *
   * The store's job is "migrate on read, and write back without bumping the version". *Which*
   * migrations those are is not its business, which is why this is a parameter and not an
   * import.
   */
  migrate?: (raw: unknown) => MigrationResult;
}

interface ScoreRow {
  id: string;
  owner: string;
  title: string;
  composer: string;
  key: string;
  updated_at: string;
  version: number;
  doc: string;
}

export function openSqliteStore(options: SqliteStoreOptions): ScoreStore {
  const db: Database = new SqliteDatabase(options.filename);
  migrateTables(db);
  const now = options.now ?? (() => new Date());
  const migrate = options.migrate ?? migrateDocument;

  const statements = {
    list: db.prepare<[Owner], ListingRow>(
      `SELECT id, title, composer, key, updated_at, version
         FROM scores WHERE owner = ? ORDER BY updated_at DESC, id ASC`,
    ),
    get: db.prepare<[Owner, Id], ScoreRow>(`SELECT * FROM scores WHERE owner = ? AND id = ?`),
    exists: db.prepare<[Owner, Id], { one: number }>(
      `SELECT 1 AS one FROM scores WHERE owner = ? AND id = ?`,
    ),
    insert: db.prepare(
      `INSERT INTO scores (id, owner, title, composer, key, updated_at, version, doc)
       VALUES (@id, @owner, @title, @composer, @key, @updated_at, 1, @doc)`,
    ),
    update: db.prepare(
      `UPDATE scores
          SET title = @title, composer = @composer, key = @key,
              updated_at = @updated_at, version = version + 1, doc = @doc
        WHERE owner = @owner AND id = @id AND version = @expected_version`,
    ),
    /**
     * The migration write-back (ADR-0028), and the reason it is a statement of its own:
     * `version` is conspicuously absent from the SET clause. A migration is not an edit, and
     * bumping the version here would spuriously invalidate a client's expectedVersion. There
     * is deliberately no general "update the document" statement that could be used for this
     * by accident.
     */
    rewriteMigrated: db.prepare(
      `UPDATE scores SET doc = @doc, title = @title, composer = @composer, key = @key
        WHERE owner = @owner AND id = @id AND version = @version`,
    ),
    delete: db.prepare(`DELETE FROM scores WHERE owner = ? AND id = ?`),

    // The log. Append-only: there is no UPDATE and no DELETE against it, because rewriting
    // history is exactly what undo-by-replay must never be able to do (ADR-0003). Rows go only
    // when the score they belong to does, by cascade.
    appendOp: db.prepare(
      `INSERT INTO operations (owner, score_id, seq, batch, op_version, type, payload, created_at)
       VALUES (@owner, @score_id, @seq, @batch, @op_version, @type, @payload, @created_at)`,
    ),
    listOps: db.prepare<[Owner, Id], OperationRow>(
      `SELECT seq, batch, op_version, payload, created_at
         FROM operations
        WHERE owner = ? AND score_id = ?
        ORDER BY seq ASC`,
    ),
    /** Where the next operation and the next batch go. */
    nextSeq: db.prepare<[Owner, Id], { next_seq: number; next_batch: number }>(
      `SELECT COALESCE(MAX(seq), 0) + 1  AS next_seq,
              COALESCE(MAX(batch), 0) + 1 AS next_batch
         FROM operations WHERE owner = ? AND score_id = ?`,
    ),
  };

  /**
   * Append a batch of operations as one undoable unit (ADR-0003). Sequence numbers are gapless
   * per score and assigned here rather than by the caller, so the log's order is the store's to
   * guarantee.
   */
  function appendOperations(owner: Owner, scoreId: Id, operations: readonly StoredOperation[]): void {
    const cursor = statements.nextSeq.get(owner, scoreId) ?? { next_seq: 1, next_batch: 1 };
    operations.forEach((operation, offset) => {
      statements.appendOp.run({
        owner,
        score_id: scoreId,
        seq: cursor.next_seq + offset,
        batch: cursor.next_batch,
        op_version: operation.version,
        type: operation.operation.type,
        payload: JSON.stringify(operation.operation),
        created_at: operation.createdAt,
      });
    });
  }

  function refuseEmpty(operations: readonly StoredOperation[]): void {
    assertCarriesOperations(operations);
  }

  function get(owner: Owner, id: Id): ScoreRecord | null {
    const row = statements.get.get(owner, id);
    if (row === undefined) return null;

    // Migrate on read (ADR-0028). A document this build cannot understand throws
    // DocumentMigrationError rather than being read on a best-effort basis.
    const result = migrate(JSON.parse(row.doc));
    if (result.migrated) {
      statements.rewriteMigrated.run({
        ...listingColumns(result.score),
        owner,
        id,
        version: row.version,
        doc: JSON.stringify(result.score),
      });
    }
    return { score: result.score, version: row.version, updatedAt: row.updated_at };
  }

  // The two writes stay synchronous transactions inside — better-sqlite3's `transaction` is what
  // makes each one atomic — and are exposed through `async` methods below (V18, ADR-0034). SQLite
  // never yields mid-write, so wrapping does not loosen atomicity; it only matches the port's type.
  const createTx = db.transaction((owner: Owner, score: Score, operations: readonly StoredOperation[]) => {
    refuseEmpty(operations);
    const updatedAt = timestamp(now);
    try {
      statements.insert.run({
        ...listingColumns(score),
        id: score.id,
        owner,
        updated_at: updatedAt,
        doc: JSON.stringify(score),
      });
    } catch (error) {
      // Let the primary key answer rather than checking first, so the check and the write
      // cannot come apart. An id collision means a bug upstream, not a user error.
      if (isUniqueViolation(error)) return { ok: false, reason: 'already-exists' } as const;
      throw error;
    }
    appendOperations(owner, score.id, operations);
    return { ok: true, version: 1, updatedAt } as const;
  });

  const commitTx = db.transaction(
    (
      owner: Owner,
      id: Id,
      expectedVersion: number,
      score: Score,
      operations: readonly StoredOperation[],
    ) => {
      refuseEmpty(operations);
      const updatedAt = timestamp(now);
      const outcome = statements.update.run({
        ...listingColumns(score),
        owner,
        id,
        expected_version: expectedVersion,
        updated_at: updatedAt,
        doc: JSON.stringify(score),
      });

      if (outcome.changes === 1) {
        // Inside the same transaction as the version check, so a document can never be written
        // without the operations that caused it, and vice versa.
        appendOperations(owner, id, operations);
        return { ok: true, version: expectedVersion + 1, updatedAt } as const;
      }

      // The statement matched nothing, so either the score is gone or the version moved.
      // Reading the row is what tells the client which, and gives it the version to retry at.
      const row = statements.get.get(owner, id);
      if (row === undefined) return { ok: false, reason: 'not-found' } as const;
      return { ok: false, reason: 'conflict', version: row.version } as const;
    },
  );

  return {
    async list(owner) {
      return statements.list.all(owner).map(toListing);
    },

    async get(owner, id) {
      return get(owner, id);
    },

    async exists(owner, id) {
      return statements.exists.get(owner, id) !== undefined;
    },

    async operations(owner, id) {
      return statements.listOps.all(owner, id).map(toStoredOperation);
    },

    async create(owner, score, operations) {
      return createTx(owner, score, operations);
    },

    async commit(owner, id, expectedVersion, score, operations) {
      return commitTx(owner, id, expectedVersion, score, operations);
    },

    async delete(owner, id) {
      return statements.delete.run(owner, id).changes === 1;
    },

    async close() {
      db.close();
    },
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('SQLITE_CONSTRAINT')
  );
}
