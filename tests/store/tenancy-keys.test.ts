import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_OWNER } from '@sibei/api';
import { TABLE_SCHEMA_VERSION, openSqliteStore } from '@sibei/api/sqlite';
import type { ScoreStore } from '@sibei/api';
import { aScore, anEdit, creationOf, insert, update } from './helpers.js';

/**
 * Ownership is part of the key (table schema version 5, V19a).
 *
 * Until v5 `scores.id` alone was the primary key. With one owner that is invisible; with two it is
 * wrong twice over: two users could not each have a chart called "soul", and creating an id that
 * another owner held reported `already-exists` — telling one tenant that another tenant's id exists.
 * These pin the behaviour a hosted store needs, and the migration that brings an existing local
 * library there without losing a row or reordering a log.
 */

/**
 * The raw driver, for the two things only a raw connection can do: build a database in an *old* shape
 * and attempt a write the port would never issue. It is resolved from `packages/api` because that is the
 * one package that depends on it — the tests do not, deliberately, so the driver stays the API's alone.
 */
const SqliteDatabase = createRequire(resolve(import.meta.dirname, '../../packages/api/package.json'))(
  'better-sqlite3',
) as new (filename: string) => RawDatabase;

/** Just the slice of the driver these tests use; the full types live with `packages/api`. */
interface RawDatabase {
  pragma(source: string, options?: { simple: boolean }): unknown;
  exec(sql: string): unknown;
  prepare(sql: string): { run(...parameters: unknown[]): unknown };
  close(): void;
}

const stores: ScoreStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  while (stores.length > 0) await stores.pop()?.close();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function fresh(): ScoreStore {
  const store = openSqliteStore({ filename: ':memory:' });
  stores.push(store);
  return store;
}

function scratchFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'sibei-tenancy-'));
  directories.push(directory);
  return join(directory, 'library.db');
}

describe('a chart id is unique per owner, not globally', () => {
  it('lets two owners each have a chart with the same id', async () => {
    const store = fresh();
    expect(await insert(store, 'alice', aScore('soul', "Alice's Soul"))).toMatchObject({ ok: true });
    // Not `already-exists`: that id belongs to somebody else, and is none of bob's business.
    expect(await insert(store, 'bob', aScore('soul', "Bob's Soul"))).toMatchObject({ ok: true, version: 1 });

    expect((await store.get('alice', 'soul'))?.score.meta.title).toBe("Alice's Soul");
    expect((await store.get('bob', 'soul'))?.score.meta.title).toBe("Bob's Soul");
  });

  it('still refuses a second create of the same id by the same owner', async () => {
    const store = fresh();
    await insert(store, 'alice', aScore('soul'));
    expect(await insert(store, 'alice', aScore('soul'))).toEqual({ ok: false, reason: 'already-exists' });
  });

  it('keeps each owner\'s library to themselves', async () => {
    const store = fresh();
    await insert(store, 'alice', aScore('soul'));
    await insert(store, 'bob', aScore('soul'));
    await insert(store, 'bob', aScore('blue-bossa'));
    expect((await store.list('alice')).map((row) => row.id)).toEqual(['soul']);
    expect((await store.list('bob')).map((row) => row.id).sort()).toEqual(['blue-bossa', 'soul']);
    expect(await store.exists('alice', 'blue-bossa')).toBe(false);
  });
});

describe('the op log is keyed by owner too', () => {
  it('numbers each owner\'s log from 1, independently, for the same chart id', async () => {
    const store = fresh();
    await insert(store, 'alice', aScore('soul'));
    await insert(store, 'bob', aScore('soul'));
    await update(store, 'alice', 'soul', 1, aScore('soul', 'Alice v2'));

    const alice = await store.operations('alice', 'soul');
    const bob = await store.operations('bob', 'soul');
    expect(alice.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(bob.map((entry) => entry.seq)).toEqual([1]);
    expect(alice.map((entry) => entry.batch)).toEqual([1, 2]);
  });

  it('does not let one owner\'s edit land in, or bump, another owner\'s chart', async () => {
    const store = fresh();
    await insert(store, 'alice', aScore('soul'));
    await insert(store, 'bob', aScore('soul'));
    expect(await store.commit('alice', 'soul', 1, aScore('soul', 'Alice v2'), anEdit())).toMatchObject({
      ok: true,
      version: 2,
    });
    expect((await store.get('bob', 'soul'))?.version).toBe(1);
    // ...and the stale-version answer is about the caller's own chart.
    expect(await store.commit('bob', 'soul', 2, aScore('soul'), anEdit())).toEqual({
      ok: false,
      reason: 'conflict',
      version: 1,
    });
  });

  it('deletes only the caller\'s chart and only the caller\'s log', async () => {
    const store = fresh();
    await insert(store, 'alice', aScore('soul'));
    await insert(store, 'bob', aScore('soul'));
    expect(await store.delete('alice', 'soul')).toBe(true);
    expect(await store.exists('alice', 'soul')).toBe(false);
    expect(await store.operations('alice', 'soul')).toEqual([]);
    expect(await store.exists('bob', 'soul')).toBe(true);
    expect(await store.operations('bob', 'soul')).toHaveLength(1);
  });

  it('refuses to attach a log to a chart that does not exist for that owner', async () => {
    // The composite foreign key: an operation cannot outlive, or precede, its score. A raw insert
    // for a chart only bob has, under alice's owner, must fail rather than dangle.
    const filename = scratchFile();
    const store = openSqliteStore({ filename });
    stores.push(store);
    await insert(store, 'bob', aScore('soul'));
    const raw = new SqliteDatabase(filename);
    raw.pragma('foreign_keys = ON');
    try {
      expect(() =>
        raw
          .prepare(
            `INSERT INTO operations (owner, score_id, seq, batch, op_version, type, payload, created_at)
             VALUES ('alice', 'soul', 1, 1, 1, 'meta.set', '{}', '2026-01-01T00:00:00Z')`,
          )
          .run(),
      ).toThrow(/FOREIGN KEY/);
    } finally {
      raw.close();
    }
  });
});

describe('migrating a pre-v5 library', () => {
  /** The v4 shape exactly as it shipped: `id` alone is the key, and operations carry no owner. */
  function buildV4Library(filename: string): void {
    const db = new SqliteDatabase(filename);
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE scores (
        id TEXT NOT NULL PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, composer TEXT NOT NULL,
        key TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL,
        doc TEXT NOT NULL CHECK (json_valid(doc))
      );
      CREATE INDEX scores_owner_updated ON scores (owner, updated_at DESC);
      CREATE TABLE operations (
        score_id TEXT NOT NULL REFERENCES scores (id) ON DELETE CASCADE, seq INTEGER NOT NULL,
        batch INTEGER NOT NULL, op_version INTEGER NOT NULL, type TEXT NOT NULL,
        payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL,
        PRIMARY KEY (score_id, seq)
      );
    `);
    const insertScore = db.prepare(
      `INSERT INTO scores (id, owner, title, composer, key, updated_at, version, doc)
       VALUES (?, 'local', ?, 'Johnny Green', 'Db', '2026-07-01T10:00:00Z', ?, ?)`,
    );
    const insertOp = db.prepare(
      `INSERT INTO operations (score_id, seq, batch, op_version, type, payload, created_at)
       VALUES (?, ?, ?, 1, ?, ?, '2026-07-01T10:00:00Z')`,
    );
    for (const [id, version] of [['soul', 3], ['bossa', 1]] as const) {
      insertScore.run(id, `Title of ${id}`, version, JSON.stringify(aScore(id, `Title of ${id}`)));
    }
    // soul has three batches (one op, then a two-op batch, then one), bossa just its creation.
    insertOp.run('soul', 1, 1, 'score.create', JSON.stringify(creationOf(aScore('soul'))[0]!.operation));
    insertOp.run('soul', 2, 2, 'meta.set', '{"type":"meta.set","payload":{"style":"a"}}');
    insertOp.run('soul', 3, 2, 'meta.set', '{"type":"meta.set","payload":{"style":"b"}}');
    insertOp.run('bossa', 1, 1, 'score.create', JSON.stringify(creationOf(aScore('bossa'))[0]!.operation));
    db.pragma('user_version = 4');
    db.close();
  }

  it('keeps every chart, its version and its whole log, in order', async () => {
    const filename = scratchFile();
    buildV4Library(filename);

    const store = openSqliteStore({ filename });
    stores.push(store);

    expect((await store.list(LOCAL_OWNER)).map((row) => row.id).sort()).toEqual(['bossa', 'soul']);
    // A migration is not an edit (ADR-0028): the version is exactly what it was.
    expect((await store.get(LOCAL_OWNER, 'soul'))?.version).toBe(3);
    expect((await store.get(LOCAL_OWNER, 'bossa'))?.version).toBe(1);

    const log = await store.operations(LOCAL_OWNER, 'soul');
    expect(log.map((entry) => [entry.seq, entry.batch, entry.operation.type])).toEqual([
      [1, 1, 'score.create'],
      [2, 2, 'meta.set'],
      [3, 2, 'meta.set'],
    ]);
    expect(await store.operations(LOCAL_OWNER, 'bossa')).toHaveLength(1);
  });

  it('brings the table version to the current one, and a second open is a no-op', async () => {
    const filename = scratchFile();
    buildV4Library(filename);
    await openSqliteStore({ filename }).close();
    const raw = new SqliteDatabase(filename);
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(TABLE_SCHEMA_VERSION);
    } finally {
      raw.close();
    }
    // Reopening must not rebuild again (the tables are already v5) or lose anything.
    const again = openSqliteStore({ filename });
    stores.push(again);
    expect(await again.list(LOCAL_OWNER)).toHaveLength(2);
  });

  it('leaves the migrated library able to take a second owner with the same ids', async () => {
    const filename = scratchFile();
    buildV4Library(filename);
    const store = openSqliteStore({ filename });
    stores.push(store);
    expect(await insert(store, 'someone-else', aScore('soul', 'Not local'))).toMatchObject({ ok: true });
    expect((await store.get(LOCAL_OWNER, 'soul'))?.score.meta.title).toBe('Title of soul');
    // ...and the migrated log still appends from where it left off, per owner.
    expect(await store.commit(LOCAL_OWNER, 'soul', 3, aScore('soul', 'edited'), anEdit())).toMatchObject({
      ok: true,
      version: 4,
    });
    expect((await store.operations(LOCAL_OWNER, 'soul')).map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });

  it('refuses a database from a newer table version, as before', () => {
    const filename = scratchFile();
    const db = new SqliteDatabase(filename);
    db.pragma(`user_version = ${TABLE_SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openSqliteStore({ filename })).toThrow(/only understands/);
  });
});
