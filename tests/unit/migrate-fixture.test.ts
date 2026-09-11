import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, migrateDocument } from '@sibei/model';
import type { RawDocument } from '@sibei/model';

/**
 * A real fixture document carried from the earliest schema version to the current one — the
 * integration test ADR-0028's standing tax demands, and the V8 test plan names. `score-v1.json` is a
 * whole chart as a v1 build would have written it: notes, a rest, chords, a section, a repeat with an
 * ending, and — the point — **no `spellingPinned` anywhere**, because that field did not exist yet.
 *
 * This is the fixture that caught a real gap. The v1 -> v2 migration backfilled `spellingPinned` onto
 * chords but not onto notes, even though V6d added the field to both; the old test never saw it
 * because its v1 fixture had no notes. Migrating a real chart, with both, is what surfaced it — the
 * bug is fixed in `migrate.ts` and this asserts the fix.
 */

const RAW = readFileSync(join(import.meta.dirname, '../fixtures/score-v1.json'), 'utf8');

/** The document, freshly parsed each call so a mutation in one test cannot leak into another. */
function v1(): RawDocument {
  return JSON.parse(RAW) as RawDocument;
}

describe('a real fixture climbs from the earliest schema version to the current one (ADR-0028)', () => {
  it('runs the chain and stamps the current version', () => {
    const result = migrateDocument(v1());
    expect(result.migrated).toBe(true);
    expect(result.from).toBe(1);
    expect(result.score.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('backfills spellingPinned onto every note AND every chord (the gap V8f closed)', () => {
    const { score } = migrateDocument(v1());
    const notes = score.bars.flatMap((bar) => bar.items.filter((i) => i.kind === 'note'));
    const chords = score.bars.flatMap((bar) => bar.chords);

    expect(notes.length).toBe(4);
    expect(chords.length).toBe(3);
    expect(notes.every((n) => n.kind === 'note' && n.spellingPinned === false)).toBe(true);
    expect(chords.every((c) => c.spellingPinned === false)).toBe(true);
  });

  it('leaves a rest untouched: rests carry no spelling pin', () => {
    const { score } = migrateDocument(v1());
    const rest = score.bars[0]!.items.find((i) => i.kind === 'rest');
    expect(rest).toBeDefined();
    expect('spellingPinned' in (rest as object)).toBe(false);
  });

  it('changes nothing else — only the new fields and the version are added', () => {
    const { score } = migrateDocument(v1());

    // The expected current document is the v1 one with exactly `spellingPinned: false` added to each
    // note and chord and the version bumped. Deep equality proves the migration added those and
    // touched nothing else — structure, ties, the repeat, the ending and the section all preserved.
    const expected = v1();
    expected.schemaVersion = SCHEMA_VERSION;
    for (const bar of expected.bars as RawDocument[]) {
      bar.items = (bar.items as RawDocument[]).map((item) =>
        item.kind === 'note' ? { ...item, spellingPinned: false } : item,
      );
      bar.chords = (bar.chords as RawDocument[]).map((chord) => ({ ...chord, spellingPinned: false }));
    }

    expect(score).toEqual(expected);
  });

  it('preserves the musical content a reader would check first', () => {
    const { score } = migrateDocument(v1());
    expect(score.meta).toMatchObject({ title: 'Blue Bossa', composer: 'Kenny Dorham', style: 'Bossa' });
    expect(score.bars).toHaveLength(2);
    expect(score.bars[0]!.startBarline).toBe('repeat-start');
    expect(score.bars[1]!.endBarline).toBe('repeat-end');
    expect(score.bars[1]!.ending).toEqual({ numbers: [1], role: 'start-stop' });
    expect(score.sections).toEqual([{ id: 'section-1', startBar: 1, letter: 'A', name: 'Head' }]);
  });
});
