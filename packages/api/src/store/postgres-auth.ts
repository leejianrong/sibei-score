import { randomUUID } from 'node:crypto';
import type { Pool, PoolConfig } from 'pg';
import { TOKEN_SCOPES } from './auth.js';
import type { ApiToken, AuthStore, DevicePoll, ProviderProfile, Session, TokenPrincipal, TokenScope, User, UserId } from './auth.js';
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

interface TokenRow {
  id: string;
  name: string;
  scopes: string;
  created_at: string;
  expires_at: string;
}

function scopesOf(stored: string): TokenScope[] {
  return stored.split(' ').filter((s): s is TokenScope => (TOKEN_SCOPES as readonly string[]).includes(s));
}

function toToken(row: TokenRow): ApiToken {
  return { id: row.id, name: row.name, scopes: scopesOf(row.scopes), createdAt: row.created_at, expiresAt: row.expires_at };
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

    async createDevice(device) {
      await asSystem(pool, async (client) => {
        await client.query(
          `INSERT INTO device_codes (device_hash, user_code, status, created_at, expires_at) VALUES ($1, $2, 'pending', $3, $4)`,
          [device.deviceHash, device.userCode, timestamp(now), device.expiresAt],
        );
      });
    },

    async approveDevice(userCode, approval, at) {
      return asSystem(pool, async (client) => {
        const result = await client.query(
          `UPDATE device_codes SET status = 'approved', user_id = $1, name = $2, scopes = $3
            WHERE user_code = $4 AND status = 'pending' AND expires_at COLLATE "C" > $5 COLLATE "C"`,
          [approval.userId, approval.name, approval.scopes.join(' '), userCode, at],
        );
        return result.rowCount === 1;
      });
    },

    async pollDevice(deviceHash, at, minIntervalMs): Promise<DevicePoll> {
      return asSystem(pool, async (client) => {
        // Lock the row for the rest of the transaction, so two polls cannot both read an approval and
        // both return it: the second waits, then finds the row gone.
        const found = await client.query<{
          status: string;
          user_id: string | null;
          name: string | null;
          scopes: string | null;
          expires_at: string;
          last_polled_at: string | null;
        }>(
          `SELECT status, user_id, name, scopes, expires_at, last_polled_at
             FROM device_codes WHERE device_hash = $1 FOR UPDATE`,
          [deviceHash],
        );
        const row = found.rows[0];
        if (row === undefined || row.expires_at <= at) return { status: 'expired' };
        if (row.status === 'approved') {
          await client.query(`DELETE FROM device_codes WHERE device_hash = $1`, [deviceHash]);
          return { status: 'authorized', userId: row.user_id!, name: row.name!, scopes: scopesOf(row.scopes!) };
        }
        if (row.last_polled_at !== null && Date.parse(at) - Date.parse(row.last_polled_at) < minIntervalMs) {
          return { status: 'slow-down' };
        }
        await client.query(`UPDATE device_codes SET last_polled_at = $2 WHERE device_hash = $1`, [deviceHash, at]);
        return { status: 'pending' };
      });
    },

    async createToken(token): Promise<ApiToken> {
      const createdAt = timestamp(now);
      await asSystem(pool, async (client) => {
        await client.query(
          `INSERT INTO api_tokens (id, token_hash, user_id, name, scopes, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [token.id, token.tokenHash, token.userId, token.name, token.scopes.join(' '), createdAt, token.expiresAt],
        );
      });
      return { id: token.id, name: token.name, scopes: token.scopes, createdAt, expiresAt: token.expiresAt };
    },

    async findToken(tokenHash, at): Promise<TokenPrincipal | null> {
      return asSystem(pool, async (client) => {
        const result = await client.query<{ id: string; user_id: string; scopes: string }>(
          `SELECT id, user_id, scopes FROM api_tokens
            WHERE token_hash = $1 AND expires_at COLLATE "C" > $2 COLLATE "C"`,
          [tokenHash, at],
        );
        const row = result.rows[0];
        return row === undefined ? null : { id: row.id, userId: row.user_id, scopes: scopesOf(row.scopes) };
      });
    },

    async listTokens(userId) {
      return asSystem(pool, async (client) => {
        const result = await client.query<TokenRow>(
          `SELECT id, name, scopes, created_at, expires_at FROM api_tokens WHERE user_id = $1 ORDER BY seq DESC`,
          [userId],
        );
        return result.rows.map(toToken);
      });
    },

    async revokeToken(userId, id) {
      return asSystem(pool, async (client) => {
        const result = await client.query(`DELETE FROM api_tokens WHERE id = $1 AND user_id = $2`, [id, userId]);
        return result.rowCount === 1;
      });
    },

    async purgeExpiredCredentials(at) {
      return asSystem(pool, async (client) => {
        const devices = await client.query(`DELETE FROM device_codes WHERE expires_at COLLATE "C" <= $1 COLLATE "C"`, [at]);
        const tokens = await client.query(`DELETE FROM api_tokens WHERE expires_at COLLATE "C" <= $1 COLLATE "C"`, [at]);
        return (devices.rowCount ?? 0) + (tokens.rowCount ?? 0);
      });
    },

    async close() {
      await closeHandle(handle);
    },
  };
}
