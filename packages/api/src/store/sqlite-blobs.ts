import SqliteDatabase from 'better-sqlite3';
import { migrateTables } from './sqlite-schema.js';
import type { BlobKey } from '../blob/blob-store.js';
import type { BlobLedger, BlobRef } from './blob-ledger.js';
import type { Owner } from './repository.js';
import { timestamp } from './store-shared.js';

/**
 * The SQLite blob ledger (V25). A fifth file that knows SQLite exists, argued for the way the job and
 * identity stores are: its own connection to the shared file, its own port (`blob-ledger.ts`), and a table
 * (`blob_refs`) created by the one `migrateTables`. The table is additive and idempotent, so it needed no
 * table-schema bump.
 */
export interface SqliteBlobLedgerOptions {
  filename: string;
  now?: () => Date;
}

interface RefRow {
  owner: string;
  key: string;
  kind: string;
  recorded_at: string;
}

const toRef = (row: RefRow): BlobRef => ({ owner: row.owner, key: row.key, kind: row.kind, recordedAt: row.recorded_at });

export function openSqliteBlobLedger(options: SqliteBlobLedgerOptions): BlobLedger {
  const db = new SqliteDatabase(options.filename);
  migrateTables(db);
  const now = options.now ?? (() => new Date());

  const statements = {
    record: db.prepare(`INSERT OR IGNORE INTO blob_refs (owner, key, kind, recorded_at) VALUES (?, ?, ?, ?)`),
    list: db.prepare<[Owner], RefRow>(`SELECT owner, key, kind, recorded_at FROM blob_refs WHERE owner = ? ORDER BY recorded_at, key`),
    forget: db.prepare(`DELETE FROM blob_refs WHERE owner = ? AND key = ?`),
    forgetAll: db.prepare(`DELETE FROM blob_refs WHERE owner = ?`),
    olderThan: db.prepare<[string, string, number], RefRow>(
      `SELECT owner, key, kind, recorded_at FROM blob_refs WHERE kind = ? AND recorded_at < ? ORDER BY recorded_at, key LIMIT ?`,
    ),
  };

  return {
    async record(owner: Owner, key: BlobKey, kind: string) {
      statements.record.run(owner, key, kind, timestamp(now));
    },
    async list(owner) {
      return statements.list.all(owner).map(toRef);
    },
    async forget(owner, key) {
      statements.forget.run(owner, key);
    },
    async forgetAll(owner) {
      statements.forgetAll.run(owner);
    },
    async olderThan(kind, before, limit) {
      return statements.olderThan.all(kind, before, limit).map(toRef);
    },
    async close() {
      db.close();
    },
  };
}
