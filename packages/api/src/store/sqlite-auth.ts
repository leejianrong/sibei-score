import SqliteDatabase from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { migrateTables } from './sqlite-schema.js';
import type { AuthStore, ProviderProfile, Session, User, UserId } from './auth.js';
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
  };

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
    async close() {
      db.close();
    },
  };
}
