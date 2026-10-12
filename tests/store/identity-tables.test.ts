import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TABLE_SCHEMA_VERSION, openSqliteAuthStore, openSqliteStore } from '@sibei/api/sqlite';
import { aScore, insert } from './helpers.js';

/**
 * Table schema version 6 adds identity (V20, ADR-0034): `users`, `identities`, `sessions`. It is purely
 * additive, so the migration is "create three tables" — and the property worth pinning is the one a
 * migration exists to keep: a library written at v5 opens at v6 with every score and every log row intact.
 * (The contract of the identity store itself is `conformance.ts`, run against both adapters.)
 */

const SqliteDatabase = createRequire(resolve(import.meta.dirname, '../../packages/api/package.json'))(
  'better-sqlite3',
) as new (filename: string) => RawDatabase;

interface RawDatabase {
  pragma(source: string, options?: { simple: boolean }): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): { all(...parameters: unknown[]): unknown[] };
  close(): void;
}

const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function scratchFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'sibei-identity-'));
  directories.push(directory);
  return join(directory, 'library.db');
}

describe('table schema version 6', () => {
  it('has moved on to the version that adds API tokens (V21a), which is additive over identity', () => {
    expect(TABLE_SCHEMA_VERSION).toBe(7);
  });

  it('takes a v5 library to v6 without losing a score or a log row, and then signs somebody in', async () => {
    const filename = scratchFile();
    const first = openSqliteStore({ filename });
    await insert(first, 'local', aScore('soul'));
    await first.close();

    // Turn it back into exactly what a V19 install holds: v5, and no identity tables.
    const raw = new SqliteDatabase(filename);
    raw.exec('DROP TABLE api_tokens; DROP TABLE device_codes; DROP TABLE sessions; DROP TABLE identities; DROP TABLE users;');
    raw.pragma('user_version = 5');
    raw.close();

    const second = openSqliteStore({ filename });
    const auth = openSqliteAuthStore({ filename });
    try {
      expect((await second.get('local', 'soul'))?.version).toBe(1);
      expect((await second.operations('local', 'soul')).length).toBeGreaterThan(0);

      const user = await auth.signIn({ provider: 'github', subject: '1', login: 'a', name: null });
      await auth.createSession('h', user.id, '2999-01-01T00:00:00Z');
      expect(await auth.findSession('h', '2026-10-01T00:00:00Z')).toMatchObject({ userId: user.id });
    } finally {
      await second.close();
      await auth.close();
    }

    const check = new SqliteDatabase(filename);
    expect(check.pragma('user_version', { simple: true })).toBe(TABLE_SCHEMA_VERSION);
    const tables = check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['users', 'identities', 'sessions', 'device_codes', 'api_tokens']));
    check.close();
  });

  it("keeps the library's own owner out of the identity tables: `local` is not a user", async () => {
    const filename = scratchFile();
    const store = openSqliteStore({ filename });
    await insert(store, 'local', aScore('soul'));
    const auth = openSqliteAuthStore({ filename });
    const user = await auth.signIn({ provider: 'github', subject: '1', login: 'a', name: null });
    // A user's id can never be the local owner, so signing in can never alias onto the local library.
    expect(user.id).not.toBe('local');
    expect(await auth.getUser('local')).toBeNull();
    await store.close();
    await auth.close();
  });
});

describe('table schema version 7 (V21a)', () => {
  it('takes a v6 library to v7 keeping every user and session, and then mints a token', async () => {
    const filename = scratchFile();
    const first = openSqliteAuthStore({ filename });
    const user = await first.signIn({ provider: 'github', subject: '1', login: 'a', name: null });
    await first.createSession('h', user.id, '2999-01-01T00:00:00Z');
    await first.close();

    // Exactly what a V20 install holds: v6, and no token or device tables.
    const raw = new SqliteDatabase(filename);
    raw.exec('DROP TABLE api_tokens; DROP TABLE device_codes;');
    raw.pragma('user_version = 6');
    raw.close();

    const second = openSqliteAuthStore({ filename });
    try {
      expect(await second.getUser(user.id)).toMatchObject({ login: 'a' });
      expect(await second.findSession('h', '2026-10-01T00:00:00Z')).toMatchObject({ userId: user.id });
      await second.createToken({
        id: 'tok_1',
        tokenHash: 'th',
        userId: user.id,
        name: 'laptop',
        scopes: ['read'],
        expiresAt: '2999-01-01T00:00:00Z',
      });
      expect(await second.findToken('th', '2026-10-01T00:00:00Z')).toMatchObject({ userId: user.id });
    } finally {
      await second.close();
    }
  });
});
