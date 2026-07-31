import { describe, expect, it } from 'vitest';
import {
  DOCUMENT_MIGRATIONS,
  DocumentMigrationError,
  SCHEMA_VERSION,
  makeBar,
  makeNote,
  makeScore,
  dur,
  migrateDocument,
  migrateDocumentWith,
} from '@sibei/model';
import type { DocumentMigration, RawDocument } from '@sibei/model';

/**
 * The migration runner (ADR-0028). Forward-only, on read, and loud in both directions it can
 * fail.
 *
 * `DOCUMENT_MIGRATIONS` is still empty — SCHEMA_VERSION has been 1 since the first commit —
 * so most of this drives the runner against a *synthetic* chain. That is the point: the
 * machinery gets proven before there is a real migration riding on it, which is the whole
 * argument for paying ADR-0028's near-zero cost now rather than guessing later.
 */

function aScore() {
  const bar = makeBar({
    id: 'bar-1',
    number: 1,
    items: [makeNote({ id: 'note-1', onset: 0, duration: dur(1), pitch: 'Eb5' })],
  });
  return makeScore({ id: 'score-1', title: 'Body and Soul', composer: 'Green', bars: [bar] });
}

/** A document as it would have been written by a build one schema version ago. */
function atVersion(version: number): RawDocument {
  return { ...(JSON.parse(JSON.stringify(aScore())) as RawDocument), schemaVersion: version };
}

describe('the real chain', () => {
  it('reads a current document without migrating it', () => {
    const result = migrateDocument(atVersion(SCHEMA_VERSION));
    expect(result.migrated).toBe(false);
    expect(result.from).toBe(SCHEMA_VERSION);
    expect(result.score.meta.title).toBe('Body and Soul');
  });

  it('has one migration per version step, with no gaps and no duplicates', () => {
    // The chain must cover 1..SCHEMA_VERSION-1 exactly, or a document written by an older
    // build becomes unreadable — which is the failure this ADR exists to prevent.
    const froms = DOCUMENT_MIGRATIONS.map((m) => m.from);
    expect(froms).toEqual([...froms].sort((a, b) => a - b));
    expect(new Set(froms).size).toBe(froms.length);
    for (let version = 1; version < SCHEMA_VERSION; version += 1) {
      expect(froms).toContain(version);
    }
  });

  it('refuses a document from a newer schema version, rather than guessing', () => {
    // The worst available outcome is a quiet misread of irreplaceable data, so this is a hard
    // error and the message says what to do about it.
    const attempt = () => migrateDocument(atVersion(SCHEMA_VERSION + 1));
    expect(attempt).toThrow(DocumentMigrationError);
    expect(attempt).toThrow(/only understands/);
    try {
      attempt();
    } catch (error) {
      expect((error as DocumentMigrationError).failure).toEqual({
        kind: 'from-the-future',
        found: SCHEMA_VERSION + 1,
        supported: SCHEMA_VERSION,
      });
    }
  });
});

describe('a synthetic chain, to prove the machinery', () => {
  /**
   * Invented, but shaped like the commonest real migration there is: a new field, backfilled
   * onto objects written before it existed. Climbing from 1 rather than 0 because version 0 is
   * genuinely bogus — the first commit shipped SCHEMA_VERSION = 1, so nothing legitimate is
   * below it.
   */
  const BACKFILL_SWING: DocumentMigration = {
    from: 1,
    note: 'v2 gave every bar a `swing` flag, off for everything written before it',
    migrate(document) {
      const bars = document.bars as RawDocument[];
      return { ...document, bars: bars.map((bar) => ({ ...bar, swing: false })) };
    },
  };

  function swingOf(score: unknown): unknown[] {
    return ((score as { bars: { swing?: unknown }[] }).bars ?? []).map((bar) => bar.swing);
  }

  it('carries a document forward one step and stamps the new version', () => {
    const result = migrateDocumentWith(atVersion(1), [BACKFILL_SWING], 2);
    expect(result.migrated).toBe(true);
    expect(result.from).toBe(1);
    expect(result.score.schemaVersion).toBe(2);
    expect(swingOf(result.score)).toEqual([false]);
    // The migration is pure: what it did not touch came through untouched.
    expect(result.score.meta.title).toBe('Body and Soul');
    expect(result.score.bars[0]?.items[0]?.id).toBe('note-1');
  });

  it('runs every step in order when more than one applies', () => {
    const trail: number[] = [];
    const step = (from: number): DocumentMigration => ({
      from,
      note: `step ${from}`,
      migrate(document) {
        trail.push(from);
        return document;
      },
    });
    const result = migrateDocumentWith(atVersion(1), [step(3), step(1), step(2)], 4);
    expect(trail).toEqual([1, 2, 3]);
    expect(result.score.schemaVersion).toBe(4);
  });

  it('does not mutate the document it was handed', () => {
    const original = atVersion(1);
    const snapshot = JSON.stringify(original);
    migrateDocumentWith(original, [BACKFILL_SWING], 2);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('fails loudly when the chain has a hole', () => {
    // Two versions to climb, one migration to climb them with.
    const attempt = () => migrateDocumentWith(atVersion(1), [BACKFILL_SWING], 3);
    expect(attempt).toThrow(DocumentMigrationError);
    expect(attempt).toThrow(/no migration from 2 to 3/);
  });

  it('fails loudly when a migration returns the wrong shape', () => {
    const dropsTheBars: DocumentMigration = {
      from: 1,
      note: 'a migration with a bug in it',
      migrate: (document) => ({ ...document, bars: 'oops' }),
    };
    expect(() => migrateDocumentWith(atVersion(1), [dropsTheBars], 2)).toThrow(
      /bars is not an array/,
    );
  });
});

describe('documents that are not documents', () => {
  it.each([
    ['null', null],
    ['an array', [{ schemaVersion: 1 }]],
    ['a string', '{"schemaVersion":1}'],
    ['a number', 7],
  ])('rejects %s', (_label, raw) => {
    expect(() => migrateDocument(raw)).toThrow(DocumentMigrationError);
  });

  it.each([
    ['a missing version', {}],
    ['a non-numeric version', { schemaVersion: '1' }],
    ['a fractional version', { schemaVersion: 1.5 }],
    ['version zero', { schemaVersion: 0 }],
  ])('rejects %s', (_label, raw) => {
    expect(() => migrateDocument(raw)).toThrow(/no usable schemaVersion/);
  });

  it('rejects a document at the right version with the wrong shape', () => {
    expect(() => migrateDocument({ schemaVersion: SCHEMA_VERSION })).toThrow(
      /id is not a string; meta is missing/,
    );
  });
});
