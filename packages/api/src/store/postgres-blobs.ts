import type { Pool, PoolConfig } from 'pg';
import type { BlobKey } from '../blob/blob-store.js';
import type { BlobLedger, BlobRef } from './blob-ledger.js';
import { assertRlsEnforced, migratePostgres } from './postgres-schema.js';
import { asOwner, asSystem, closeHandle, poolFor } from './postgres-session.js';
import type { Owner } from './repository.js';
import { timestamp } from './store-shared.js';

/**
 * The Postgres blob ledger (V25). Owner-scoped by row-level security like the score and job tables; the
 * sweep's `olderThan` is the one cross-owner read and runs as the system actor, which `blob_refs`'
 * policy admits for exactly that reason (it shares the job table's policy).
 */
export interface PostgresBlobLedgerOptions {
  pool?: Pool;
  connectionString?: string;
  poolConfig?: PoolConfig;
  onError?: (error: Error) => void;
  now?: () => Date;
  allowRlsBypass?: boolean;
}

interface RefRow {
  owner: string;
  key: string;
  kind: string;
  recorded_at: string;
}

const toRef = (row: RefRow): BlobRef => ({ owner: row.owner, key: row.key, kind: row.kind, recordedAt: row.recorded_at });

export async function openPostgresBlobLedger(options: PostgresBlobLedgerOptions): Promise<BlobLedger> {
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

  return {
    async record(owner: Owner, key: BlobKey, kind: string) {
      await asOwner(pool, owner, (client) =>
        client.query(
          `INSERT INTO blob_refs (owner, key, kind, recorded_at) VALUES ($1, $2, $3, $4) ON CONFLICT (owner, key) DO NOTHING`,
          [owner, key, kind, timestamp(now)],
        ),
      );
    },
    async list(owner) {
      return asOwner(pool, owner, async (client) => {
        const result = await client.query<RefRow>(
          `SELECT owner, key, kind, recorded_at FROM blob_refs WHERE owner = $1 ORDER BY recorded_at, key COLLATE "C"`,
          [owner],
        );
        return result.rows.map(toRef);
      });
    },
    async forget(owner, key) {
      await asOwner(pool, owner, (client) => client.query(`DELETE FROM blob_refs WHERE owner = $1 AND key = $2`, [owner, key]));
    },
    async forgetAll(owner) {
      await asOwner(pool, owner, (client) => client.query(`DELETE FROM blob_refs WHERE owner = $1`, [owner]));
    },
    async olderThan(kind, before, limit) {
      return asSystem(pool, async (client) => {
        const result = await client.query<RefRow>(
          `SELECT owner, key, kind, recorded_at FROM blob_refs WHERE kind = $1 AND recorded_at < $2
            ORDER BY recorded_at, key COLLATE "C" LIMIT $3`,
          [kind, before, limit],
        );
        return result.rows.map(toRef);
      });
    },
    async close() {
      await closeHandle(handle);
    },
  };
}
