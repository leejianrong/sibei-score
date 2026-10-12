import SqliteDatabase from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { migrateTables } from './sqlite-schema.js';
import { TOKEN_SCOPES } from './auth.js';
import type { ApiToken, AuthStore, DevicePoll, ProviderProfile, Session, TokenPrincipal, TokenScope, User, UserId } from './auth.js';
import { timestamp } from './store-shared.js';

/**
 * The SQLite implementation of the identity port (V20, ADR-0034), the sibling of `sqlite-jobs.ts`.
 *
 * One of the files that may know SQLite exists (`tests/arch/store-seam.test.ts`), and a separate file and
 * connection from the score store for the reason the job store is: identity is not a score. The DDL lives
 * in `sqlite-schema.ts` with the other tables so there is one migration path and one version.
 *
 * Held to the same contract as `postgres-auth.ts` by one conformance suite (`tests/store/conformance.ts`).
 */

export interface SqliteAuthStoreOptions {
  /** `:memory:` for a test, a filesystem path for the real thing — the same file as the score store. */
  filename: string;
  now?: () => Date;
  newId?: () => UserId;
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

export function openSqliteAuthStore(options: SqliteAuthStoreOptions): AuthStore {
  const db: Database = new SqliteDatabase(options.filename);
  migrateTables(db);
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => `usr_${randomUUID()}`);

  const statements = {
    identity: db.prepare<[string, string], { user_id: string }>(
      `SELECT user_id FROM identities WHERE provider = ? AND subject = ?`,
    ),
    insertUser: db.prepare(`INSERT INTO users (id, login, name, created_at) VALUES (?, ?, ?, ?)`),
    insertIdentity: db.prepare(
      `INSERT INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)`,
    ),
    refresh: db.prepare(`UPDATE users SET login = ?, name = ? WHERE id = ?`),
    user: db.prepare<[string], UserRow>(`SELECT id, login, name, created_at FROM users WHERE id = ?`),
    insertSession: db.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    ),
    session: db.prepare<[string, string], { user_id: string; expires_at: string }>(
      `SELECT user_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?`,
    ),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
    purge: db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`),

    insertDevice: db.prepare(
      `INSERT INTO device_codes (device_hash, user_code, status, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?)`,
    ),
    approveDevice: db.prepare(
      `UPDATE device_codes SET status = 'approved', user_id = ?, name = ?, scopes = ?
        WHERE user_code = ? AND status = 'pending' AND expires_at > ?`,
    ),
    device: db.prepare<
      [string],
      { status: string; user_id: string | null; name: string | null; scopes: string | null; expires_at: string; last_polled_at: string | null }
    >(`SELECT status, user_id, name, scopes, expires_at, last_polled_at FROM device_codes WHERE device_hash = ?`),
    touchDevice: db.prepare(`UPDATE device_codes SET last_polled_at = ? WHERE device_hash = ?`),
    deleteDevice: db.prepare(`DELETE FROM device_codes WHERE device_hash = ?`),
    insertToken: db.prepare(
      `INSERT INTO api_tokens (id, token_hash, user_id, name, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ),
    token: db.prepare<[string, string], { id: string; user_id: string; scopes: string }>(
      `SELECT id, user_id, scopes FROM api_tokens WHERE token_hash = ? AND expires_at > ?`,
    ),
    tokens: db.prepare<[string], TokenRow>(
      `SELECT id, name, scopes, created_at, expires_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC, rowid DESC`,
    ),
    revoke: db.prepare(`DELETE FROM api_tokens WHERE id = ? AND user_id = ?`),
    purgeDevices: db.prepare(`DELETE FROM device_codes WHERE expires_at <= ?`),
    purgeTokens: db.prepare(`DELETE FROM api_tokens WHERE expires_at <= ?`),
  };

  // One synchronous transaction: read the row, decide, and (when authorised) delete it, with nothing able
  // to interleave. SQLite never yields mid-write, so two polls cannot both collect the same approval.
  const pollTx = db.transaction((deviceHash: string, at: string, minIntervalMs: number): DevicePoll => {
    const row = statements.device.get(deviceHash);
    if (row === undefined || row.expires_at <= at) return { status: 'expired' };
    if (row.status === 'approved') {
      statements.deleteDevice.run(deviceHash);
      return { status: 'authorized', userId: row.user_id!, name: row.name!, scopes: scopesOf(row.scopes!) };
    }
    if (row.last_polled_at !== null && Date.parse(at) - Date.parse(row.last_polled_at) < minIntervalMs) {
      // Too soon. Not recorded as a poll, so hammering cannot push the next allowed poll further away.
      return { status: 'slow-down' };
    }
    statements.touchDevice.run(at, deviceHash);
    return { status: 'pending' };
  });

  // One synchronous transaction, so the lookup and the insert cannot come apart: SQLite never yields
  // mid-write, which is what makes first sign-in race-free here without an ON CONFLICT dance.
  const signInTx = db.transaction((profile: ProviderProfile): User => {
    const existing = statements.identity.get(profile.provider, profile.subject);
    if (existing !== undefined) {
      statements.refresh.run(profile.login, profile.name, existing.user_id);
      return toUser(statements.user.get(existing.user_id)!);
    }
    const id = newId();
    const createdAt = timestamp(now);
    statements.insertUser.run(id, profile.login, profile.name, createdAt);
    statements.insertIdentity.run(profile.provider, profile.subject, id, createdAt);
    return { id, login: profile.login, name: profile.name, createdAt };
  });

  return {
    async signIn(profile) {
      return signInTx(profile);
    },
    async getUser(id) {
      const row = statements.user.get(id);
      return row === undefined ? null : toUser(row);
    },
    async createSession(tokenHash, userId, expiresAt) {
      statements.insertSession.run(tokenHash, userId, timestamp(now), expiresAt);
    },
    async findSession(tokenHash, at): Promise<Session | null> {
      const row = statements.session.get(tokenHash, at);
      return row === undefined ? null : { userId: row.user_id, expiresAt: row.expires_at };
    },
    async deleteSession(tokenHash) {
      return statements.deleteSession.run(tokenHash).changes === 1;
    },
    async purgeExpiredSessions(at) {
      return statements.purge.run(at).changes;
    },

    async createDevice(device) {
      statements.insertDevice.run(device.deviceHash, device.userCode, timestamp(now), device.expiresAt);
    },
    async approveDevice(userCode, approval, at) {
      return (
        statements.approveDevice.run(approval.userId, approval.name, approval.scopes.join(' '), userCode, at).changes === 1
      );
    },
    async pollDevice(deviceHash, at, minIntervalMs) {
      return pollTx(deviceHash, at, minIntervalMs);
    },
    async createToken(token): Promise<ApiToken> {
      const createdAt = timestamp(now);
      statements.insertToken.run(token.id, token.tokenHash, token.userId, token.name, token.scopes.join(' '), createdAt, token.expiresAt);
      return { id: token.id, name: token.name, scopes: token.scopes, createdAt, expiresAt: token.expiresAt };
    },
    async findToken(tokenHash, at): Promise<TokenPrincipal | null> {
      const row = statements.token.get(tokenHash, at);
      return row === undefined ? null : { id: row.id, userId: row.user_id, scopes: scopesOf(row.scopes) };
    },
    async listTokens(userId) {
      return statements.tokens.all(userId).map(toToken);
    },
    async revokeToken(userId, id) {
      return statements.revoke.run(id, userId).changes === 1;
    },
    async purgeExpiredCredentials(at) {
      return statements.purgeDevices.run(at).changes + statements.purgeTokens.run(at).changes;
    },
    async close() {
      db.close();
    },
  };
}
