import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  POSTGRES_TABLE_SCHEMA_VERSION,
  openPostgresAccountStore,
  openPostgresJobStore,
  openPostgresStore,
} from '@sibei/api/postgres';
import type { AccountStore, JobStore, ScoreStore } from '@sibei/api';
import { aScore, anEdit, insert } from '../store/helpers.js';
import { pg, provisionDatabase, quiet } from './support.js';
import type { PgPool, TestDatabase } from './support.js';

/**
 * What only Postgres can be wrong about (V19, ADR-0034): the *mechanisms* behind the port. The port's
 * behaviour is `conformance.test.ts`'s, shared with SQLite; this is row-level security, the row lock that
 * decides a race, `SKIP LOCKED`, the migration, and the refusals.
 *
 * Every assertion here runs as the ordinary `sibei_app` role that RLS binds (see `support.ts`) — a
 * superuser passes every policy, so a test that used one would prove nothing.
 */

let database: TestDatabase;
const closers: Array<() => Promise<void>> = [];

beforeEach(async () => {
  database = await provisionDatabase();
});

afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  await database.drop();
});

async function openStore(): Promise<ScoreStore> {
  const store = await openPostgresStore({ connectionString: database.url, onError: quiet });
  closers.push(() => store.close());
  return store;
}

async function openJobs(): Promise<JobStore> {
  const jobs = await openPostgresJobStore({ connectionString: database.url, onError: quiet });
  closers.push(() => jobs.close());
  return jobs;
}

async function openAccounts(): Promise<AccountStore> {
  const accounts = await openPostgresAccountStore({ connectionString: database.url, onError: quiet });
  closers.push(() => accounts.close());
  return accounts;
}

/** A raw pool as the application role: the same privileges the adapter has, and nothing it adds. */
async function rawAppPool(max = 4): Promise<PgPool> {
  const pool = new pg.Pool({ connectionString: database.url, max });
  pool.on('error', quiet);
  closers.push(() => pool.end());
  return pool;
}

/** Run raw SQL as the app role with `app.owner` (and optionally `app.system`) set, in one transaction. */
async function asRaw<T>(
  pool: PgPool,
  settings: { owner?: string; system?: boolean },
  work: (query: PgPool['query']) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (settings.owner !== undefined) await client.query(`SELECT set_config('app.owner', $1, true)`, [settings.owner]);
    if (settings.system === true) await client.query(`SELECT set_config('app.system', 'on', true)`);
    const result = await work((sql, params) => client.query(sql, params));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

describe('the test database itself', () => {
  it('is locale-aware, so the conformance suite\'s byte-order check can fail', async () => {
    // Guards the guard. In a `C` locale `'blue' < 'Soul'` is false for *every* query, with or without
    // `COLLATE "C"`, and the byte-order test would pass for the wrong reason. See `support.ts`.
    const pool = await rawAppPool();
    expect((await pool.query(`SELECT 'blue' < 'Soul' AS locale_aware`)).rows[0]).toEqual({ locale_aware: true });
    expect((await pool.query(`SELECT ('blue' COLLATE "C") < 'Soul' AS byte_order`)).rows[0]).toEqual({ byte_order: false });
  });

  it('is owned by a role row-level security actually binds', async () => {
    const pool = await rawAppPool();
    const role = (await pool.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe('row-level security is a real backstop, not just a second WHERE', () => {
  it('shows a session nothing at all until it says who is asking (default deny)', async () => {
    const store = await openStore();
    await insert(store, 'alice', aScore('soul'));
    const pool = await rawAppPool();
    // No app.owner set: every row is invisible, though the table is not empty.
    expect((await pool.query(`SELECT count(*)::int AS n FROM scores`)).rows[0]).toEqual({ n: 0 });
    expect((await pool.query(`SELECT count(*)::int AS n FROM operations`)).rows[0]).toEqual({ n: 0 });
  });

  it('hides another owner\'s rows even from a query with no WHERE clause at all', async () => {
    const store = await openStore();
    await insert(store, 'alice', aScore('soul', "Alice's"));
    await insert(store, 'bob', aScore('soul', "Bob's"));
    await insert(store, 'bob', aScore('blue-bossa'));
    const pool = await rawAppPool();
    // The adapter's own filters are deliberately absent here: this is what a route that forgot one sees.
    const bobs = await asRaw(pool, { owner: 'bob' }, (query) => query(`SELECT owner, id FROM scores ORDER BY id`));
    expect(bobs.rows).toEqual([
      { owner: 'bob', id: 'blue-bossa' },
      { owner: 'bob', id: 'soul' },
    ]);
    const ops = await asRaw(pool, { owner: 'alice' }, (query) => query(`SELECT DISTINCT owner FROM operations`));
    expect(ops.rows).toEqual([{ owner: 'alice' }]);
  });

  it('refuses to write a row as an owner you are not, and cannot move or delete one either', async () => {
    const store = await openStore();
    await insert(store, 'alice', aScore('soul'));
    const pool = await rawAppPool();

    await expect(
      asRaw(pool, { owner: 'bob' }, (query) =>
        query(
          `INSERT INTO scores (owner, id, title, composer, key, updated_at, version, doc)
           VALUES ('alice', 'forged', 't', 'c', 'C', '2026-01-01T00:00:00Z', 1, '{}')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);

    // Bob's UPDATE and DELETE against Alice's row match nothing: it is not visible to him.
    const updated = await asRaw(pool, { owner: 'bob' }, (query) => query(`UPDATE scores SET title = 'hijacked' WHERE id = 'soul'`));
    expect(updated.rowCount).toBe(0);
    const deleted = await asRaw(pool, { owner: 'bob' }, (query) => query(`DELETE FROM scores WHERE id = 'soul'`));
    expect(deleted.rowCount).toBe(0);
    expect((await store.get('alice', 'soul'))?.score.meta.title).toBe('Body and Soul');
  });

  it('cannot be re-pointed at another owner mid-transaction through the adapter\'s own path', async () => {
    // `set_config(…, true)` is transaction-local: after the transaction the setting is gone, so a pooled
    // connection handed to the next request does not inherit the last caller's identity. One connection
    // makes the reuse certain.
    const store = await openPostgresStore({ connectionString: database.url, onError: quiet, poolConfig: { max: 1 } });
    closers.push(() => store.close());
    await insert(store, 'alice', aScore('soul'));
    expect(await store.get('bob', 'soul')).toBeNull();
    expect((await store.get('alice', 'soul'))?.version).toBe(1);
    expect(await store.get('bob', 'soul')).toBeNull();
  });

  it('leaves no owner setting behind on a pooled connection', async () => {
    const store = await openPostgresStore({ connectionString: database.url, onError: quiet });
    closers.push(() => store.close());
    await insert(store, 'alice', aScore('soul'));
    const pool = await rawAppPool(1);
    await asRaw(pool, { owner: 'alice' }, (query) => query(`SELECT 1`));
    // Same single connection, new transaction, nothing set: the previous identity must not linger.
    const seen = (await pool.query(`SELECT current_setting('app.owner', true) AS owner`)).rows[0]?.owner;
    expect(seen === null || seen === '').toBe(true);
    expect((await pool.query(`SELECT count(*)::int AS n FROM scores`)).rows[0]).toEqual({ n: 0 });
  });

  it('admits the system actor to import_jobs only — never to a score', async () => {
    const store = await openStore();
    const jobs = await openJobs();
    await insert(store, 'alice', aScore('soul'));
    await jobs.create('alice', ['k1']);
    await jobs.create('bob', ['k2']);
    const pool = await rawAppPool();
    // The runner sees every owner's queue...
    const queue = await asRaw(pool, { system: true }, (query) => query(`SELECT owner FROM import_jobs ORDER BY owner`));
    expect(queue.rows).toEqual([{ owner: 'alice' }, { owner: 'bob' }]);
    // ...but the same privilege does not reach a score or its log.
    const scores = await asRaw(pool, { system: true }, (query) => query(`SELECT count(*)::int AS n FROM scores`));
    expect(scores.rows[0]).toEqual({ n: 0 });
    const operations = await asRaw(pool, { system: true }, (query) => query(`SELECT count(*)::int AS n FROM operations`));
    expect(operations.rows[0]).toEqual({ n: 0 });
  });

  it('does not let an owner-scoped session see the job queue of others', async () => {
    const jobs = await openJobs();
    await jobs.create('alice', ['k1']);
    await jobs.create('bob', ['k2']);
    const pool = await rawAppPool();
    const seen = await asRaw(pool, { owner: 'bob' }, (query) => query(`SELECT owner FROM import_jobs`));
    expect(seen.rows).toEqual([{ owner: 'bob' }]);
  });
});

describe('identity tables are behind row-level security too (V20)', () => {
  /** Two users signed in, each with a session — the fixture every check below reads through raw SQL. */
  async function twoUsers() {
    const accounts = await openAccounts();
    const alice = await accounts.signIn({ provider: 'github', subject: '1', displayName: 'Alice', avatarUrl: null });
    const bob = await accounts.signIn({ provider: 'github', subject: '2', displayName: 'Bob', avatarUrl: null });
    await accounts.createSession(alice.id, 'alice-hash', { ttlMs: 3_600_000, idleMs: 600_000 });
    await accounts.createSession(bob.id, 'bob-hash', { ttlMs: 3_600_000, idleMs: 600_000 });
    return { accounts, alice, bob };
  }

  it('lets an owner-scoped query see its own user row and no one else\'s, even with no WHERE', async () => {
    const { alice } = await twoUsers();
    const pool = await rawAppPool();
    const seen = await asRaw(pool, { owner: alice.id }, (query) => query(`SELECT id FROM users`));
    expect(seen.rows).toEqual([{ id: alice.id }]);
    const none = await pool.query(`SELECT count(*)::int AS n FROM users`);
    expect(none.rows[0]).toEqual({ n: 0 });
  });

  it('shows an owner-scoped query no session and no identity — not even its own', async () => {
    const { alice } = await twoUsers();
    const pool = await rawAppPool();
    for (const table of ['sessions', 'identities']) {
      const seen = await asRaw(pool, { owner: alice.id }, (query) => query(`SELECT count(*)::int AS n FROM ${table}`));
      expect(seen.rows[0], table).toEqual({ n: 0 });
    }
    // Reading is not the only door: an owner cannot mint a session for itself, or for anyone.
    await expect(
      asRaw(pool, { owner: alice.id }, (query) =>
        query(
          `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, idle_until, idle_ms)
           VALUES ('forged', $1, 'x', 'x', 'x', 1)`,
          [alice.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('cannot rewrite another user\'s profile or delete their row from an owner-scoped session', async () => {
    const { accounts, alice, bob } = await twoUsers();
    const pool = await rawAppPool();
    const changed = await asRaw(pool, { owner: alice.id }, (query) =>
      query(`UPDATE users SET display_name = 'pwned' WHERE id = $1`, [bob.id]),
    );
    expect(changed.rowCount).toBe(0);
    const deleted = await asRaw(pool, { owner: alice.id }, (query) => query(`DELETE FROM users WHERE id = $1`, [bob.id]));
    expect(deleted.rowCount).toBe(0);
    expect((await accounts.getUser(bob.id))?.displayName).toBe('Bob');
  });

  it('lets the system actor reach the identity tables, but never a score or its log', async () => {
    const { alice } = await twoUsers();
    const store = await openStore();
    await insert(store, alice.id, aScore('soul'));
    const pool = await rawAppPool();
    const sessions = await asRaw(pool, { system: true }, (query) => query(`SELECT count(*)::int AS n FROM sessions`));
    expect(sessions.rows[0]).toEqual({ n: 2 });
    const scores = await asRaw(pool, { system: true }, (query) => query(`SELECT count(*)::int AS n FROM scores`));
    expect(scores.rows[0]).toEqual({ n: 0 });
  });

  it('resolves a session to its own user only, and getUser is the only owner-scoped door', async () => {
    const { accounts, alice, bob } = await twoUsers();
    expect((await accounts.resolveSession('alice-hash'))?.id).toBe(alice.id);
    expect((await accounts.resolveSession('bob-hash'))?.id).toBe(bob.id);
    // A user id is not a credential: the store has no way to ask for a session by user.
    expect(await accounts.resolveSession(alice.id)).toBeNull();
  });

  it('stores only the hash it was given, and nothing that looks like a raw token', async () => {
    const accounts = await openAccounts();
    const user = await accounts.signIn({ provider: 'github', subject: '9', displayName: 'Eve', avatarUrl: null });
    await accounts.createSession(user.id, 'a-hash', { ttlMs: 60_000, idleMs: 60_000 });
    const pool = await rawAppPool();
    const rows = await asRaw(pool, { system: true }, (query) => query(`SELECT * FROM sessions`));
    expect(Object.keys(rows.rows[0]!).sort()).toEqual(
      ['created_at', 'expires_at', 'idle_ms', 'idle_until', 'token_hash', 'user_id'],
    );
  });
});

describe('the adapter refuses to run where row-level security would not apply', () => {
  it('refuses a superuser, naming why and what to do', async () => {
    await expect(openPostgresStore({ connectionString: database.superuserUrl })).rejects.toThrow(/superuser or has BYPASSRLS/);
    await expect(openPostgresJobStore({ connectionString: database.superuserUrl })).rejects.toThrow(/NOSUPERUSER NOBYPASSRLS/);
    await expect(openPostgresAccountStore({ connectionString: database.superuserUrl })).rejects.toThrow(/superuser or has BYPASSRLS/);
  });

  it('lets a developer opt out knowingly, and nothing else', async () => {
    const store = await openPostgresStore({ connectionString: database.superuserUrl, allowRlsBypass: true });
    closers.push(() => store.close());
    expect(await store.list('alice')).toEqual([]);
  });

  it('does not create anything before it has refused', async () => {
    await expect(openPostgresStore({ connectionString: database.superuserUrl })).rejects.toThrow();
    const admin = new pg.Client({ connectionString: database.superuserUrl });
    await admin.connect();
    try {
      const tables = await admin.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'scores'`);
      expect(tables.rows[0]).toEqual({ n: 0 });
    } finally {
      await admin.end();
    }
  });
});

describe('the migration', () => {
  it('is safe to run from many processes at once (replicas booting together)', async () => {
    const opened = await Promise.all(Array.from({ length: 6 }, () => openPostgresStore({ connectionString: database.url })));
    for (const store of opened) closers.push(() => store.close());
    // All six coexisted; the tables are usable and the version is recorded exactly once.
    expect(await insert(opened[0]!, 'alice', aScore('soul'))).toMatchObject({ ok: true });
    expect((await opened[5]!.get('alice', 'soul'))?.version).toBe(1);
    const pool = await rawAppPool();
    expect((await pool.query(`SELECT value FROM schema_meta WHERE key = 'table_version'`)).rows).toEqual([{ value: POSTGRES_TABLE_SCHEMA_VERSION }]);
  });

  it('is idempotent: reopening keeps every row', async () => {
    const first = await openPostgresStore({ connectionString: database.url, onError: quiet });
    await insert(first, 'alice', aScore('soul'));
    await first.close();
    const second = await openPostgresStore({ connectionString: database.url, onError: quiet });
    closers.push(() => second.close());
    expect((await second.get('alice', 'soul'))?.version).toBe(1);
  });

  it('refuses a database from a newer table version, as SQLite does', async () => {
    const first = await openPostgresStore({ connectionString: database.url, onError: quiet });
    await first.close();
    const admin = new pg.Client({ connectionString: database.superuserUrl });
    await admin.connect();
    try {
      await admin.query(`UPDATE schema_meta SET value = 99 WHERE key = 'table_version'`);
    } finally {
      await admin.end();
    }
    await expect(openPostgresStore({ connectionString: database.url })).rejects.toThrow(/only understands/);
  });

  it('turns row-level security on and forces it, so it binds the table owner too', async () => {
    const store = await openStore();
    expect(store).toBeDefined();
    const pool = await rawAppPool();
    const flags = await pool.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('scores', 'operations', 'import_jobs', 'users', 'identities', 'sessions')
        ORDER BY relname`,
    );
    expect(flags.rows).toEqual(
      ['identities', 'import_jobs', 'operations', 'scores', 'sessions', 'users'].map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })),
    );
  });
});

describe('a dropped connection does not take the process down', () => {
  it('reports it, discards the dead connection and serves the next call on a fresh one', async () => {
    // A restart, a failover or an idle timeout takes connections away from under a running API. `pg`
    // reports that as an `error` event on the pool, and an unlistened `error` event is an uncaught
    // exception — i.e. the process dies. The adapter listens, so it survives; this proves it end to end by
    // having the *server* kill every connection the adapter holds.
    const reported: string[] = [];
    const store = await openPostgresStore({
      connectionString: database.url,
      onError: (error) => reported.push(error.message),
    });
    closers.push(() => store.close());
    await insert(store, 'alice', aScore('soul'));
    expect((await store.get('alice', 'soul'))?.version).toBe(1); // a connection is now idle in the pool

    const admin = new pg.Client({ connectionString: database.superuserUrl });
    await admin.connect();
    try {
      const killed = await admin.query(
        `SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity
          WHERE datname = current_database() AND usename = 'sibei_app' AND pid <> pg_backend_pid()`,
      );
      expect(killed.rows.length).toBeGreaterThan(0);
    } finally {
      await admin.end();
    }

    // Give the socket close a turn to arrive; then the very next call must simply work.
    await new Promise((resolve) => setImmediate(resolve));
    expect((await store.get('alice', 'soul'))?.score.meta.title).toBe('Body and Soul');
    expect(reported.some((message) => /terminating connection/.test(message))).toBe(true);
  });
});

describe('concurrency is decided by the database, not by luck', () => {
  it('lets exactly one of many writers at the same version win, and logs exactly one edit', async () => {
    const store = await openPostgresStore({ connectionString: database.url, onError: quiet, poolConfig: { max: 10 } });
    closers.push(() => store.close());
    await insert(store, 'alice', aScore('soul', 'Original'));

    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, index) => store.commit('alice', 'soul', 1, aScore('soul', `Writer ${index}`), anEdit())),
    );
    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(9);
    // Every loser is told the version to retry at (ADR-0003) — not an error, not a lost update.
    for (const loser of losers) expect(loser).toEqual({ ok: false, reason: 'conflict', version: 2 });

    const record = await store.get('alice', 'soul');
    expect(record?.version).toBe(2);
    // The winner's document is the one stored, and the log holds the create plus exactly that one edit,
    // numbered without a gap: the seq is read under the row lock, so appends cannot interleave.
    expect(record?.score.meta.title).toMatch(/^Writer \d$/);
    expect((await store.operations('alice', 'soul')).map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it('numbers the log without gaps or duplicates under a chain of contended writes', async () => {
    const store = await openPostgresStore({ connectionString: database.url, onError: quiet, poolConfig: { max: 10 } });
    closers.push(() => store.close());
    await insert(store, 'alice', aScore('soul'));
    // Several writers, each retrying on conflict until it lands: the realistic client behaviour.
    async function land(tag: number): Promise<void> {
      for (;;) {
        const current = await store.get('alice', 'soul');
        const outcome = await store.commit('alice', 'soul', current!.version, aScore('soul', `w${tag}`), anEdit());
        if (outcome.ok) return;
      }
    }
    await Promise.all(Array.from({ length: 8 }, (_, tag) => land(tag)));
    expect((await store.get('alice', 'soul'))?.version).toBe(9);
    const log = await store.operations('alice', 'soul');
    expect(log.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(log.map((entry) => entry.batch)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('hands twenty jobs to twenty concurrent claimers across two runner processes, once each', async () => {
    // Two separate job stores stand in for two processes with their own pools: SKIP LOCKED is what lets
    // them claim at the same instant without waiting on each other or taking the same job.
    const runnerA = await openPostgresJobStore({ connectionString: database.url, onError: quiet, poolConfig: { max: 10 } });
    const runnerB = await openPostgresJobStore({ connectionString: database.url, onError: quiet, poolConfig: { max: 10 } });
    closers.push(() => runnerA.close(), () => runnerB.close());
    await Promise.all(Array.from({ length: 20 }, (_, index) => runnerA.create('alice', [`k${index}`])));

    const claims = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? runnerA : runnerB).claim()));
    const ids = claims.map((job) => job?.id);
    expect(ids.every((id) => id !== undefined)).toBe(true);
    expect(new Set(ids).size).toBe(20);
    expect(claims.every((job) => job?.status === 'running' && job.attempts === 1)).toBe(true);
    expect(await runnerA.claim()).toBeNull();
  });
});
