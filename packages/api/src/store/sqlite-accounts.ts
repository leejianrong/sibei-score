import SqliteDatabase from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { isLapsed, sessionDeadlines, slidIdleUntil, toUser } from './account-shared.js';
import type { UserRow } from './account-shared.js';
import type { AccountStore, ProviderProfile, SessionPolicy, UserId } from './accounts.js';
import { migrateTables } from './sqlite-schema.js';
import { timestamp } from './store-shared.js';

/**
 * The SQLite implementation of the account port (V20, ADR-0034), the sibling of `sqlite-jobs.ts` and
 * the fourth file that knows SQLite exists. A separate file and connection for the reason the job store
 * is: a mutable session row does not belong behind the op log's single writer (ADR-0003). The tables live
 * in `sqlite-schema.ts` so there is one migration path; this adapter just calls `migrateTables`.
 *
 * SQLite has no row-level security and needs none: it is the local-mode database, where the only owner
 * is `local` and accounts are unused. It exists so the port has one contract (`tests/store/conformance.ts`)
 * and so a single-user install can still be run with login on.
 */

export interface SqliteAccountStoreOptions {
  filename: string;
  now?: () => Date;
  newId?: () => UserId;
}

interface SessionJoinRow extends UserRow {
  token_hash: string;
  expires_at: string;
  idle_until: string;
  idle_ms: number;
}

export function openSqliteAccountStore(options: SqliteAccountStoreOptions): AccountStore {
  const db: Database = new SqliteDatabase(options.filename);
  migrateTables(db);
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());

  const statements = {
    identity: db.prepare<[string, string], { user_id: string }>(
      `SELECT user_id FROM identities WHERE provider = ? AND subject = ?`,
    ),
    insertUser: db.prepare(
      `INSERT INTO users (id, display_name, avatar_url, created_at) VALUES (@id, @display_name, @avatar_url, @created_at)`,
    ),
    insertIdentity: db.prepare(`INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)`),
    refresh: db.prepare(`UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?`),
    user: db.prepare<[UserId], UserRow>(`SELECT * FROM users WHERE id = ?`),
    insertSession: db.prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, idle_until, idle_ms)
       VALUES (@token_hash, @user_id, @created_at, @expires_at, @idle_until, @idle_ms)`,
    ),
    session: db.prepare<[string], SessionJoinRow>(
      `SELECT u.id, u.display_name, u.avatar_url, u.created_at,
              s.token_hash, s.expires_at, s.idle_until, s.idle_ms
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    ),
    slide: db.prepare(`UPDATE sessions SET idle_until = ? WHERE token_hash = ?`),
    deleteSession: db.prepare(`DELETE FROM sessions WHERE token_hash = ?`),
    purge: db.prepare(`DELETE FROM sessions WHERE expires_at <= ? OR idle_until <= ?`),
  };

  // better-sqlite3 is synchronous, so a transaction here is atomic against every other statement in
  // this process; the async surface is the port's, not the driver's (V18).
  const signIn = db.transaction((profile: ProviderProfile) => {
    const known = statements.identity.get(profile.provider, profile.subject);
    if (known !== undefined) {
      statements.refresh.run(profile.displayName, profile.avatarUrl, known.user_id);
      return statements.user.get(known.user_id) as UserRow;
    }
    const row: UserRow = {
      id: newId(),
      display_name: profile.displayName,
      avatar_url: profile.avatarUrl,
      created_at: timestamp(now),
    };
    statements.insertUser.run(row);
    statements.insertIdentity.run(profile.provider, profile.subject, row.id);
    return row;
  });

  return {
    async signIn(profile) {
      return toUser(signIn(profile));
    },

    async getUser(id) {
      const row = statements.user.get(id);
      return row === undefined ? null : toUser(row);
    },

    async createSession(userId, tokenHash, policy: SessionPolicy) {
      const { expiresAt, idleUntil } = sessionDeadlines(now, policy);
      statements.insertSession.run({
        token_hash: tokenHash,
        user_id: userId,
        created_at: timestamp(now),
        expires_at: expiresAt,
        idle_until: idleUntil,
        idle_ms: policy.idleMs,
      });
    },

    async resolveSession(tokenHash) {
      const row = statements.session.get(tokenHash);
      if (row === undefined) return null;
      if (isLapsed(row.expires_at, row.idle_until, timestamp(now))) {
        statements.deleteSession.run(tokenHash);
        return null;
      }
      const slid = slidIdleUntil(now, { expiresAt: row.expires_at, idleUntil: row.idle_until, idleMs: row.idle_ms });
      if (slid !== null) statements.slide.run(slid, tokenHash);
      return toUser(row);
    },

    async deleteSession(tokenHash) {
      statements.deleteSession.run(tokenHash);
    },

    async purgeExpiredSessions() {
      const at = timestamp(now);
      return statements.purge.run(at, at).changes;
    },

    async close() {
      db.close();
    },
  };
}
