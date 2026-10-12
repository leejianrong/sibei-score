import { randomUUID } from 'node:crypto';
import type { Pool, PoolConfig } from 'pg';
import type { AuthStore, ProviderProfile, Session, User, UserId } from './auth.js';
import { assertRlsEnforced, migratePostgres } from './postgres-schema.js';
import { asSystem, closeHandle, poolFor } from './postgres-session.js';
import { timestamp } from './store-shared.js';

/**
 * The Postgres implementation of the identity port (V20, ADR-0034), the sibling of `sqlite-auth.ts`.
 *
 * One of the five files that may know Postgres exists (`tests/arch/store-seam.test.ts`). Every call runs
 * as the system actor (`asSystem`): the identity tables have a single policy admitting it and no owner
 * policy at all, because a session is resolved before anyone knows whose request it is. Held to the same
 * contract as SQLite's by the shared conformance suite.
 */

export interface PostgresAuthStoreOptions {
  connectionString?: string;
  pool?: Pool;
  poolConfig?: PoolConfig;
  onError?: (error: Error) => void;
  now?: () => Date;
  newId?: () => UserId;
  /** See `PostgresStoreOptions.allowRlsBypass`. */
  allowRlsBypass?: boolean;
}

interface UserRow {
  id: string;
  login: string;
  name: string | null;
  created_at: string;
}

function toUser(row: UserRow): User {
  return { id: row.id, login: row.login, name: row.name, createdAt: row.created_at };
}

export async function openPostgresAuthStore(options: PostgresAuthStoreOptions): Promise<AuthStore> {
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
  const newId = options.newId ?? (() => `usr_${randomUUID()}`);

  return {
    async signIn(profile: ProviderProfile): Promise<User> {
      return asSystem(pool, async (client) => {
        const createdAt = timestamp(now);
        const id = newId();
        // Claim the identity first and let the primary key decide, in one statement: two first sign-ins of
        // one person at once cannot both win, and the loser falls through to reading the winner's user.
        // The user row has to exist for the foreign key, so it is inserted first and removed again (in this
        // same transaction, so nothing ever sees it) if the identity turns out to be taken.
        await client.query(`INSERT INTO users (id, login, name, created_at) VALUES ($1, $2, $3, $4)`, [
          id,
          profile.login,
          profile.name,
          createdAt,
        ]);
        const claimed = await client.query(
          `INSERT INTO identities (provider, subject, user_id, created_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (provider, subject) DO NOTHING`,
          [profile.provider, profile.subject, id, createdAt],
        );
        if (claimed.rowCount === 1) {
          return { id, login: profile.login, name: profile.name, createdAt };
        }
        await client.query(`DELETE FROM users WHERE id = $1`, [id]);
        const existing = await client.query<UserRow>(
          `UPDATE users SET login = $3, name = $4
            WHERE id = (SELECT user_id FROM identities WHERE provider = $1 AND subject = $2)
          RETURNING id, login, name, created_at`,
          [profile.provider, profile.subject, profile.login, profile.name],
        );
        return toUser(existing.rows[0]!);
      });
    },

    async getUser(id) {
      return asSystem(pool, async (client) => {
        const result = await client.query<UserRow>(
          `SELECT id, login, name, created_at FROM users WHERE id = $1`,
          [id],
        );
        const row = result.rows[0];
        return row === undefined ? null : toUser(row);
      });
    },

    async createSession(tokenHash, userId, expiresAt) {
      await asSystem(pool, async (client) => {
        await client.query(
          `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
          [tokenHash, userId, timestamp(now), expiresAt],
        );
      });
    },

    async findSession(tokenHash, at): Promise<Session | null> {
      return asSystem(pool, async (client) => {
        // COLLATE "C" so the text comparison is byte order, as SQLite's is: ISO-8601 sorts correctly under
        // either, but the two adapters should not be trusted to agree by coincidence of a database locale.
        const result = await client.query<{ user_id: string; expires_at: string }>(
          `SELECT user_id, expires_at FROM sessions
            WHERE token_hash = $1 AND expires_at COLLATE "C" > $2 COLLATE "C"`,
          [tokenHash, at],
        );
        const row = result.rows[0];
        return row === undefined ? null : { userId: row.user_id, expiresAt: row.expires_at };
      });
    },

    async deleteSession(tokenHash) {
      return asSystem(pool, async (client) => {
        const result = await client.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
        return result.rowCount === 1;
      });
    },

    async purgeExpiredSessions(at) {
      return asSystem(pool, async (client) => {
        const result = await client.query(`DELETE FROM sessions WHERE expires_at COLLATE "C" <= $1 COLLATE "C"`, [at]);
        return result.rowCount ?? 0;
      });
    },

    async close() {
      await closeHandle(handle);
    },
  };
}
