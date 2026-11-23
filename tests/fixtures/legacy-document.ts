import { barViews } from '@sibei/model';
import type { Score } from '@sibei/model';

/**
 * A score as the schema-v3 build wrote it: each bar carrying its own items, tuplets, chords and annotations, with
 * the exact key order the old `makeBar` produced. For tests that pin bytes or feed an old-shape document through
 * the ADR-0028 migration; it is the one place the retired shape is still spelled out (ADR-0041, SIB2-225).
 */
export function toLegacyDocument(score: Score, schemaVersion = 3): Record<string, unknown> {
  const bars = barViews(score).map((view) => {
    const { id, number, items, tuplets, chords, annotations, startBarline, endBarline, ending, review, lineBreak } = view;
    return {
      id,
      number,
      items,
      tuplets,
      chords,
      annotations,
      startBarline,
      endBarline,
      ending,
      review,
      ...(lineBreak === undefined ? {} : { lineBreak }),
    };
  });
  const { schemaVersion: _version, id, meta, bars: _bars, sections, harmony: _harmony, parts: _parts, ...rest } = score;
  return { schemaVersion, id, meta, bars, sections, ...rest };
}
