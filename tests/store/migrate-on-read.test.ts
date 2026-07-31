import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_OWNER, openSqliteStore } from '@sibei/api';
import type { ScoreStore } from '@sibei/api';
import {
  DocumentMigrationError,
  SCHEMA_VERSION,
  dur,
  makeBar,
  makeNote,
  makeScore,
  migrateDocumentWith,
} from '@sibei/model';
import type { DocumentMigration, Score } from '@sibei/model';

/**
 * Migration on read, end to end through the store (ADR-0028).
 *
 * `tests/unit/migrate.test.ts` proves the chain runner. This proves the two things only the
 * store can be wrong about:
 *
 *   1. A document below the current version is migrated on read, used, and **written back** at
 *      the current version.
 *   2. That write-back does **not** bump the score's `version`. A migration is not an edit, and
 *      bumping it would spuriously invalidate a client's expectedVersion (ADR-0003) — a plain
 *      read would look like somebody else's write.
 *
 * Nothing has changed the document shape yet, so there is no real older version to plant.
 * Rather than skip the most important assertion in the slice, the *chain* is injected: a store
 * opened with a synthetic one-step chain believes the current version is 2, which makes every
 * document the previous store wrote a version behind. Reopening with the real chain makes it a
 * version ahead. Both directions become constructible, and the store's contract — migrate on
 * read, write back, leave the version alone — is what is under test either way.
 *
 * Every assertion goes through the port. Reaching for the column directly would have been
 * easier and would have made this file the second thing in the tree that knows SQLite exists.
 */

const stores: ScoreStore[] = [];
const directories: string[] = [];

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

function onDisk(): string {
  const directory = mkdtempSync(join(tmpdir(), 'sibei-migrate-'));
  directories.push(directory);
  return join(directory, 'scores.db');
}

function aScore(): Score {
  const bar = makeBar({
    id: 'bar-1',
    number: 1,
    items: [makeNote({ id: 'note-1', onset: 0, duration: dur(1), pitch: 'Eb5' })],
  });
  return makeScore({ id: 'score-1', title: 'Body and Soul', bars: [bar] });
}

/** Stand-in for the first real shape change, and the commonest shape one takes. */
const BACKFILL_SWING: DocumentMigration = {
  from: 1,
  note: 'v2 gave every bar a `swing` flag',
  migrate(document) {
    const bars = document.bars as Record<string, unknown>[];
    return { ...document, bars: bars.map((bar) => ({ ...bar, swing: false })) };
  },
};

/** A store that believes the current schema version is 1: today's real code. */
function openAtV1(filename: string): ScoreStore {
  const store = openSqliteStore({ filename });
  stores.push(store);
  return store;
}

/** A store that believes the current schema version is 2, and knows how to get there. */
function openAtV2(filename: string): ScoreStore {
  const store = openSqliteStore({
    filename,
    migrate: (raw) => migrateDocumentWith(raw, [BACKFILL_SWING], 2),
  });
  stores.push(store);
  return store;
}

function closeAll(): void {
  while (stores.length > 0) stores.pop()?.close();
}

function swingOf(score: Score): unknown {
  return (score.bars[0] as unknown as { swing?: unknown }).swing;
}

describe('a document at the current version', () => {
  it('is read, and reading it twice is stable', () => {
    const filename = onDisk();
    const store = openAtV1(filename);
    store.insert(LOCAL_OWNER, aScore());

    expect(store.get(LOCAL_OWNER, 'score-1')?.score).toEqual(aScore());
    expect(store.get(LOCAL_OWNER, 'score-1')?.version).toBe(1);
    expect(store.get(LOCAL_OWNER, 'score-1')?.version).toBe(1);
  });
});

describe('a document below the current version', () => {
  it('is migrated on read, so the caller gets the current shape', () => {
    const filename = onDisk();
    openAtV1(filename).insert(LOCAL_OWNER, aScore());
    closeAll();

    const found = openAtV2(filename).get(LOCAL_OWNER, 'score-1');
    expect(found?.score.schemaVersion).toBe(2);
    expect(swingOf(found!.score)).toBe(false);
  });

  it('is written back at the current version, so the next read costs nothing', () => {
    const filename = onDisk();
    openAtV1(filename).insert(LOCAL_OWNER, aScore());
    closeAll();

    openAtV2(filename).get(LOCAL_OWNER, 'score-1');
    closeAll();

    // The write-back is what makes this throw: a store that only understands version 1 now
    // finds a version 2 document on disk. Before the read there was nothing to complain about.
    expect(() => openAtV1(filename).get(LOCAL_OWNER, 'score-1')).toThrow(/only understands/);
  });

  it('does NOT bump the score version, because a migration is not an edit', () => {
    // The assertion ADR-0028 exists for.
    const filename = onDisk();
    const first = openAtV1(filename);
    first.insert(LOCAL_OWNER, aScore());
    first.update(LOCAL_OWNER, 'score-1', 1, aScore());
    expect(first.get(LOCAL_OWNER, 'score-1')?.version).toBe(2);
    closeAll();

    const migrating = openAtV2(filename);
    expect(migrating.get(LOCAL_OWNER, 'score-1')?.version).toBe(2);
    // Twice, deliberately. The first read reports the version it loaded *before* writing back,
    // so only a second read sees what the write-back actually left behind.
    expect(migrating.get(LOCAL_OWNER, 'score-1')?.version).toBe(2);

    // And the consequence that matters: a client still holding version 2 can still write. If
    // the read had bumped, this would come back as a conflict for no reason at all.
    expect(migrating.update(LOCAL_OWNER, 'score-1', 2, aScore())).toMatchObject({
      ok: true,
      version: 3,
    });
  });

  it('does not move the timestamp either, so the library does not reorder itself for a read', () => {
    const filename = onDisk();
    const first = openAtV1(filename);
    first.insert(LOCAL_OWNER, aScore());
    const before = first.list(LOCAL_OWNER)[0]?.updatedAt;
    closeAll();

    const migrating = openAtV2(filename);
    migrating.get(LOCAL_OWNER, 'score-1');
    expect(migrating.list(LOCAL_OWNER)[0]?.updatedAt).toBe(before);
  });
});

describe('a document from a newer schema version', () => {
  /** What a build one version ahead would have left behind. */
  function fromTheFuture(): Score {
    return { ...aScore(), schemaVersion: SCHEMA_VERSION + 1 };
  }

  it('fails loudly rather than being read on a best-effort basis', () => {
    const filename = onDisk();
    const ahead = openAtV2(filename);
    ahead.insert(LOCAL_OWNER, fromTheFuture());
    closeAll();

    const behind = openAtV1(filename);
    expect(() => behind.get(LOCAL_OWNER, 'score-1')).toThrow(DocumentMigrationError);
    expect(() => behind.get(LOCAL_OWNER, 'score-1')).toThrow(/only understands/);
  });

  it('is left untouched by the failed read', () => {
    // A partial write on the way out would corrupt the one copy of data ADR-0028 calls
    // irreplaceable. The proof is that a build which *can* read it still can.
    const filename = onDisk();
    openAtV2(filename).insert(LOCAL_OWNER, fromTheFuture());
    closeAll();

    expect(() => openAtV1(filename).get(LOCAL_OWNER, 'score-1')).toThrow();
    closeAll();

    const found = openAtV2(filename).get(LOCAL_OWNER, 'score-1');
    expect(found?.score.schemaVersion).toBe(2);
    expect(found?.version).toBe(1);
  });

  it('does not stop the rest of the library being listed', () => {
    // A listing reads columns, not documents, so one unreadable chart must not take the
    // library view down with it.
    const filename = onDisk();
    openAtV2(filename).insert(LOCAL_OWNER, fromTheFuture());
    closeAll();

    expect(openAtV1(filename).list(LOCAL_OWNER).map((row) => row.id)).toEqual(['score-1']);
  });
});
