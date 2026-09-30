import { Pool } from 'pg';
import type { PoolClient, PoolConfig } from 'pg';
import type { Owner } from './repository.js';

/**
 * How the Postgres adapters run a statement: inside a transaction that first says *who is asking*
 * (V19, ADR-0034). Row-level security reads that answer (`postgres-schema.ts`), so nothing the adapters
 * run can see a row outside the caller's ownership, whether or not a `WHERE owner = …` was written.
 *
 * `set_config(…, true)` is the `SET LOCAL` form: the setting lives for the transaction and is discarded
 * at commit or rollback, so it can never leak to the next borrower of a pooled connection. That is what
 * makes this safe behind a transaction-mode pooler such as Neon's or PgBouncer's, where a plain `SET`
 * would stick to a server connection shared between requests.
 *
 * A read costs four round trips (begin, set, query, commit) rather than one. That is the price of the
 * guarantee, and it is negligible beside a database on the same host, which is where V24 puts it.
 */

/** A pool the adapter created and therefore closes, or one the caller lent it and keeps. */
export interface PoolHandle {
  pool: Pool;
  /** True when this handle made the pool, so closing the store should end it. */
  owned: boolean;
}

export function poolFor(options: {
  pool?: Pool;
  connectionString?: string;
  poolConfig?: PoolConfig;
  onError?: (error: Error) => void;
}): PoolHandle {
  if (options.pool !== undefined) return { pool: options.pool, owned: false };
  if (options.connectionString === undefined) {
    throw new Error('a Postgres store needs a `pool` or a `connectionString`');
  }
  const pool = new Pool({ connectionString: options.connectionString, ...options.poolConfig });
  // **Without this listener a dropped connection kills the process.** `pg` emits `error` on the pool when
  // the server takes an idle connection away — a restart, a failover, an idle timeout, a network blip —
  // and Node treats an `error` event nobody listens for as an uncaught exception. The pool has already
  // discarded the dead client by then and will open a fresh one on the next borrow, so the right response
  // is to report it and carry on. A pool the caller lends us is theirs to guard.
  pool.on('error', options.onError ?? reportPoolError);
  return { pool, owned: true };
}

function reportPoolError(error: Error): void {
  // The message only: a `pg` error carries the client, and with it the connection's credentials.
  console.error(`postgres: an idle connection failed and was discarded: ${error.message}`);
}

/** Run `work` as `owner`. Commits if it returns, rolls back if it throws. */
export function asOwner<T>(pool: Pool, owner: Owner, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(pool, { owner }, work);
}

/**
 * Run `work` as the system actor — the job runner, which is not owner-scoped. Only `import_jobs` has a
 * policy that admits it, so even this path cannot reach a score.
 */
export function asSystem<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  return inTransaction(pool, { system: true }, work);
}

async function inTransaction<T>(
  pool: Pool,
  who: { owner: Owner } | { system: true },
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if ('owner' in who) {
      await client.query(`SELECT set_config('app.owner', $1, true)`, [who.owner]);
    } else {
      await client.query(`SELECT set_config('app.system', 'on', true)`);
    }
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // A failed ROLLBACK (the connection died) must not mask the error that got us here.
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Close the pool if this adapter made it. A lent pool is the lender's to close. */
export async function closeHandle(handle: PoolHandle): Promise<void> {
  if (handle.owned) await handle.pool.end();
}
