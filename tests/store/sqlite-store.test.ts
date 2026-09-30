import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_OWNER } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { ScoreStore } from '@sibei/api';
import type { Score } from '@sibei/model';
import { aScore, insert, update } from './helpers.js';

/**
 * The store, against a real SQLite database (ADR-0006). The infra layer of the suite: this
 * needs better-sqlite3's native binding, which is why it does not run in the pre-push hook.
 *
 * `:memory:` for everything that does not care about the file, and a real temp file for the
 * two things that do — reopening, and the write-back on read.
 */

const stores: ScoreStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  while (stores.length > 0) await stores.pop()?.close();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function inMemory(now?: () => Date): ScoreStore {
  const store = openSqliteStore(now === undefined ? { filename: ':memory:' } : { filename: ':memory:', now });
  stores.push(store);
  return store;
}

function onDisk(): string {
  const directory = mkdtempSync(join(tmpdir(), 'sbscore-store-'));
  directories.push(directory);
  return join(directory, 'scores.db');
}

function open(filename: string): ScoreStore {
  const store = openSqliteStore({ filename });
  stores.push(store);
  return store;
}

describe('round-tripping a score', () => {
  it('stores a document and reads back exactly what went in', async () => {
    const store = inMemory();
    const score = aScore();
    expect(await insert(store, LOCAL_OWNER, score)).toMatchObject({ ok: true, version: 1 });

    const found = await store.get(LOCAL_OWNER, 'score-1');
    expect(found?.version).toBe(1);
    // `doc` is the truth, so the whole document has to survive the trip, not just the
    // columns the listing view extracts.
    expect(found?.score).toEqual(score);
  });

  it('survives a reopen of the same file', async () => {
    const filename = onDisk();
    await insert(open(filename), LOCAL_OWNER, aScore());
    expect((await open(filename).get(LOCAL_OWNER, 'score-1'))?.score).toEqual(aScore());
  });

  it('returns null for a score that is not there', async () => {
    expect(await inMemory().get(LOCAL_OWNER, 'score-404')).toBeNull();
  });

  it('refuses to insert the same id twice', async () => {
    const store = inMemory();
    await insert(store, LOCAL_OWNER, aScore());
    expect(await insert(store, LOCAL_OWNER, aScore('score-1', 'A Different Tune'))).toEqual({
      ok: false,
      reason: 'already-exists',
    });
    expect((await store.get(LOCAL_OWNER, 'score-1'))?.score.meta.title).toBe('Body and Soul');
  });

  it('deletes', async () => {
    const store = inMemory();
    await insert(store, LOCAL_OWNER, aScore());
    expect(await store.delete(LOCAL_OWNER, 'score-1')).toBe(true);
    expect(await store.get(LOCAL_OWNER, 'score-1')).toBeNull();
    expect(await store.delete(LOCAL_OWNER, 'score-1')).toBe(false);
  });
});

describe('the listing columns', () => {
  it('are derived from the document, so they cannot drift from it', async () => {
    const at = new Date('2026-07-31T09:15:30.500Z');
    const store = inMemory(() => at);
    await insert(store, LOCAL_OWNER, aScore());

    expect(await store.list(LOCAL_OWNER)).toEqual([
      {
        id: 'score-1',
        title: 'Body and Soul',
        composer: 'Johnny Green',
        key: 'Db',
        version: 1,
        updatedAt: '2026-07-31T09:15:30Z',
      },
    ]);
  });

  it('follow the document when an update changes the metadata', async () => {
    const store = inMemory();
    await insert(store, LOCAL_OWNER, aScore());
    const renamed = { ...aScore(), meta: { ...aScore().meta, title: 'Soul and Body' } };
    expect(await update(store, LOCAL_OWNER, 'score-1', 1, renamed)).toMatchObject({ ok: true });
    expect((await store.list(LOCAL_OWNER))[0]?.title).toBe('Soul and Body');
  });

  it('list nothing for an empty library', async () => {
    expect(await inMemory().list(LOCAL_OWNER)).toEqual([]);
  });
});

describe('owner', () => {
  /**
   * The value is always `local` and it always will be until the hosted transition. Filtering
   * on it anyway is what makes that transition a change to the auth seam rather than a change
   * to every statement (R8, ADR-0001).
   */
  it('scopes every read, even though the value is always local', async () => {
    const store = inMemory();
    await insert(store, LOCAL_OWNER, aScore());

    expect(await store.get('someone-else', 'score-1')).toBeNull();
    expect(await store.exists('someone-else', 'score-1')).toBe(false);
    expect(await store.list('someone-else')).toEqual([]);
    expect(await store.get(LOCAL_OWNER, 'score-1')).not.toBeNull();
  });

  it('scopes every write', async () => {
    const store = inMemory();
    await insert(store, LOCAL_OWNER, aScore());

    expect(await update(store, 'someone-else', 'score-1', 1, aScore())).toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(await store.delete('someone-else', 'score-1')).toBe(false);
    expect((await store.get(LOCAL_OWNER, 'score-1'))?.version).toBe(1);
  });

  it('is never null on a stored row', async () => {
    const store = inMemory();
    await insert(store, LOCAL_OWNER, aScore());
    // Asserted through the port rather than by reading the column, because a caller who
    // cannot find a row by owner is the failure that matters.
    expect(await store.exists(LOCAL_OWNER, 'score-1')).toBe(true);
  });
});

describe('the expected-version check (ADR-0003)', () => {
  it('bumps the version on a write that expected the current one', async () => {
    const store = inMemory();
    await insert(store, LOCAL_OWNER, aScore());
    expect(await update(store, LOCAL_OWNER, 'score-1', 1, aScore('score-1', 'Take Two'))).toMatchObject({
      ok: true,
      version: 2,
    });
    expect((await store.get(LOCAL_OWNER, 'score-1'))?.version).toBe(2);
  });

  it('rejects a stale write with the current version, and changes nothing', async () => {
    const store = inMemory();
    await insert(store, LOCAL_OWNER, aScore());
    await update(store, LOCAL_OWNER, 'score-1', 1, aScore('score-1', 'Take Two'));

    // A second client still holding version 1. No last-write-wins: it is told the version to
    // re-read at rather than quietly destroying the other party's edit.
    expect(await update(store, LOCAL_OWNER, 'score-1', 1, aScore('score-1', 'Clobbered'))).toEqual({
      ok: false,
      reason: 'conflict',
      version: 2,
    });
    expect((await store.get(LOCAL_OWNER, 'score-1'))?.score.meta.title).toBe('Take Two');
  });

  it('tells a conflict apart from a missing score', async () => {
    const store = inMemory();
    expect(await update(store, LOCAL_OWNER, 'score-404', 1, aScore('score-404'))).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('rejects a write expecting a version that has never existed', async () => {
    const store = inMemory();
    await insert(store, LOCAL_OWNER, aScore());
    expect(await update(store, LOCAL_OWNER, 'score-1', 99, aScore())).toEqual({
      ok: false,
      reason: 'conflict',
      version: 1,
    });
  });
});
