import { randomUUID } from 'node:crypto';
import type { Pool, PoolConfig } from 'pg';
import { isLapsed, sessionDeadlines, slidIdleUntil, toUser } from './account-shared.js';
import type { UserRow } from './account-shared.js';
import type { AccountStore, UserId } from './accounts.js';
import { assertRlsEnforced, migratePostgres } from './postgres-schema.js';
import { asOwner, asSystem, closeHandle, poolFor } from './postgres-session.js';
import { timestamp } from './store-shared.js';

/**
 * The Postgres implementation of the account port (V20, ADR-0034), the sibling of `sqlite-accounts.ts` and
 * the fifth file that may know Postgres exists (`tests/arch/store-seam.test.ts`).
 *
 * **Which actor each method runs as is the design** (`postgres-schema.ts` has the policies):
 *
 *   - `getUser` is `asOwner(id)` — a caller can read only its own row, which RLS enforces even if the id
 *     came from somewhere it should not have.
 *   - `signIn`, `createSession`, `resolveSession`, `deleteSession` and `purgeExpiredSessions` are
 *     `asSystem`. Each happens before an owner is known (a token *becomes* the owner), so they cannot be
 *     owner-scoped; they are the only code that sets `app.system` for `identities` and `sessions`, and no
 *     request path calls anything else.
 */

export interface PostgresAccountStoreOptions {
  connectionString?: string;
  /** A pool lent by the caller, shared with the other stores. The caller closes it. */
  pool?: Pool;
  poolConfig?: PoolConfig;
  onError?: (error: Error) => void;
  now?: () => Date;
  newId?: () => UserId;
  /** See `PostgresStoreOptions.allowRlsBypass`. */
  allowRlsBypass?: boolean;
}

interface SessionJoinRow extends UserRow {
  expires_at: string;
  idle_until: string;
  idle_ms: number;
}

export async function openPostgresAccountStore(options: PostgresAccountStoreOptions): Promise<AccountStore> {
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
    async signIn(profile) {
      return asSystem(pool, async (client) => {
        const refresh = async (userId: string): Promise<UserRow> => {
          const updated = await client.query<UserRow>(
            `UPDATE users SET display_name = $1, avatar_url = $2 WHERE id = $3 RETURNING *`,
            [profile.displayName, profile.avatarUrl, userId],
          );
          return updated.rows[0] as UserRow;
        };
        const known = await client.query<{ user_id: string }>(
          `SELECT user_id FROM identities WHERE provider = $1 AND subject = $2`,
          [profile.provider, profile.subject],
        );
        if (known.rows[0] !== undefined) return toUser(await refresh(known.rows[0].user_id));

        // A first sign-in. Two of them at once for the same person race on the identity's primary key:
        // `ON CONFLICT DO NOTHING` makes the loser wait for the winner's commit and then report no row, and
        // the loser deletes the provisional user it made and adopts the winner's. One person, one user.
        const created = timestamp(now);
        const id = newId();
        await client.query(`INSERT INTO users (id, display_name, avatar_url, created_at) VALUES ($1, $2, $3, $4)`, [
          id,
          profile.displayName,
          profile.avatarUrl,
          created,
        ]);
        const claimed = await client.query(
          `INSERT INTO identities (provider, subject, user_id) VALUES ($1, $2, $3)
           ON CONFLICT (provider, subject) DO NOTHING RETURNING user_id`,
          [profile.provider, profile.subject, id],
        );
        if (claimed.rows[0] !== undefined) {
          return { id, displayName: profile.displayName, avatarUrl: profile.avatarUrl, createdAt: created };
        }
        await client.query(`DELETE FROM users WHERE id = $1`, [id]);
        const winner = await client.query<{ user_id: string }>(
          `SELECT user_id FROM identities WHERE provider = $1 AND subject = $2`,
          [profile.provider, profile.subject],
        );
        return toUser(await refresh((winner.rows[0] as { user_id: string }).user_id));
      });
    },

    async getUser(id) {
      return asOwner(pool, id, async (client) => {
        const result = await client.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
        return result.rows[0] === undefined ? null : toUser(result.rows[0]);
      });
    },

    async createSession(userId, tokenHash, policy) {
      const { expiresAt, idleUntil } = sessionDeadlines(now, policy);
      await asSystem(pool, (client) =>
        client.query(
          `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, idle_until, idle_ms)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tokenHash, userId, timestamp(now), expiresAt, idleUntil, policy.idleMs],
        ),
      );
    },

    async resolveSession(tokenHash) {
      return asSystem(pool, async (client) => {
        const found = await client.query<SessionJoinRow>(
          `SELECT u.id, u.display_name, u.avatar_url, u.created_at, s.expires_at, s.idle_until, s.idle_ms
             FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
          [tokenHash],
        );
        const row = found.rows[0];
        if (row === undefined) return null;
        if (isLapsed(row.expires_at, row.idle_until, timestamp(now))) {
          await client.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]);
          return null;
        }
        const slid = slidIdleUntil(now, { expiresAt: row.expires_at, idleUntil: row.idle_until, idleMs: row.idle_ms });
        if (slid !== null) {
          await client.query(`UPDATE sessions SET idle_until = $1 WHERE token_hash = $2`, [slid, tokenHash]);
        }
        return toUser(row);
      });
    },

    async deleteSession(tokenHash) {
      await asSystem(pool, (client) => client.query(`DELETE FROM sessions WHERE token_hash = $1`, [tokenHash]));
    },

    async purgeExpiredSessions() {
      const at = timestamp(now);
      return asSystem(pool, async (client) => {
        const result = await client.query(`DELETE FROM sessions WHERE expires_at <= $1 OR idle_until <= $1`, [at]);
        return result.rowCount ?? 0;
      });
    },

    async close() {
      await closeHandle(handle);
    },
  };
}
