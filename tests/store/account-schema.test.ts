import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_OWNER } from '@sibei/api';
import { TABLE_SCHEMA_VERSION, openSqliteAccountStore, openSqliteStore } from '@sibei/api/sqlite';
import { aScore, insert } from './helpers.js';

/**
 * What only the SQLite account tables can be wrong about (V20): the v5 → v6 forward migration of an
 * existing local library, and the cascade a hard delete (V25) will lean on. The port's behaviour is
 * `conformance.ts`'s.
 */
// The raw driver, resolved from `packages/api` — the one package that depends on it (see tenancy-keys.test.ts).
const SqliteDatabase = createRequire(resolve(import.meta.dirname, '../../packages/api/package.json'))(
  'better-sqlite3',
) as new (filename: string) => RawDatabase;
interface RawDatabase {
  pragma(source: string, options?: { simple: boolean }): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown };
  close(): void;
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function scratchFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sibei-accounts-'));
  dirs.push(dir);
  return join(dir, 'library.sqlite');
}

describe('the account tables (table schema v6)', () => {
  it('are added to an existing v5 library without touching a single chart', async () => {
    const filename = scratchFile();
    const first = openSqliteStore({ filename });
    await insert(first, LOCAL_OWNER, aScore('soul'));
    await first.close();
    // Turn the file back into a v5 library: no identity tables, an older version stamp.
    const raw = new SqliteDatabase(filename);
    raw.exec('DROP TABLE sessions; DROP TABLE identities; DROP TABLE users;');
    raw.pragma('user_version = 5');
    raw.close();

    const accounts = openSqliteAccountStore({ filename });
    const user = await accounts.signIn({ provider: 'github', subject: '1', displayName: 'Ada', avatarUrl: null });
    await accounts.close();

    const reopened = openSqliteStore({ filename });
    try {
      expect((await reopened.get(LOCAL_OWNER, 'soul'))?.version).toBe(1);
    } finally {
      await reopened.close();
    }
    const check = new SqliteDatabase(filename);
    try {
      expect(check.pragma('user_version', { simple: true })).toBe(TABLE_SCHEMA_VERSION);
      expect(check.prepare('SELECT id FROM users').all()).toEqual([{ id: user.id }]);
    } finally {
      check.close();
    }
  });

  it('take a user\'s identities and sessions with them when the user is deleted', async () => {
    const filename = scratchFile();
    const accounts = openSqliteAccountStore({ filename });
    const user = await accounts.signIn({ provider: 'github', subject: '1', displayName: 'Ada', avatarUrl: null });
    await accounts.createSession(user.id, 'h', { ttlMs: 60_000, idleMs: 60_000 });
    await accounts.close();

    const raw = new SqliteDatabase(filename);
    try {
      raw.pragma('foreign_keys = ON');
      raw.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      expect(raw.prepare('SELECT count(*) AS n FROM identities').get()).toEqual({ n: 0 });
      expect(raw.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    } finally {
      raw.close();
    }
  });

  it('keep only a hash: the session table has no column a raw token could live in', async () => {
    const filename = scratchFile();
    const accounts = openSqliteAccountStore({ filename });
    await accounts.close();
    const raw = new SqliteDatabase(filename);
    try {
      const columns = (raw.pragma('table_info(sessions)') as { name: string }[]).map((c) => c.name).sort();
      expect(columns).toEqual(['created_at', 'expires_at', 'idle_ms', 'idle_until', 'token_hash', 'user_id']);
    } finally {
      raw.close();
    }
  });
});
