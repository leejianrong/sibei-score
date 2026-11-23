import type { Id, Score } from './score.js';
import { FIRST_VOICE, barViews, staffOf } from './staves.js';

/**
 * Stable IDs are app-owned and readable: `note-17`, `bar-3`, `chord-9` (ADR-0007).
 * A factory rather than a global counter, so a render or a test is deterministic.
 */

export type IdPrefix = 'score' | 'bar' | 'note' | 'rest' | 'chord' | 'tuplet' | 'section' | 'annotation' | 'slur' | 'ottava' | 'hairpin' | 'grace' | 'part' | 'staff';

export interface IdFactory {
  next(prefix: IdPrefix): Id;
}

export function createIdFactory(): IdFactory {
  const counters = new Map<IdPrefix, number>();
  return {
    next(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}-${n}`;
    },
  };
}

const ID_PATTERN = /^([a-z]+)-(\d+)$/;

export function parseId(id: Id): { prefix: string; ordinal: number } | null {
  const match = ID_PATTERN.exec(id);
  if (match === null) return null;
  const [, prefix, digits] = match;
  if (prefix === undefined || digits === undefined) return null;
  return { prefix, ordinal: Number(digits) };
}

/** Every id in a score, in reading order. */
export function idsOf(score: Score): Id[] {
  const ids: Id[] = [score.id];
  for (const bar of barViews(score)) {
    ids.push(bar.id);
    for (const item of bar.items) {
      ids.push(item.id);
      if (item.kind === 'note') for (const tone of item.stack ?? []) ids.push(tone.id);
      if (item.kind === 'note') for (const grace of item.graces ?? []) ids.push(grace.id);
    }
    for (const tuplet of bar.tuplets) ids.push(tuplet.id);
    for (const chord of bar.chords) ids.push(chord.id);
    for (const annotation of bar.annotations) ids.push(annotation.id);
  }
  // Everything the first staff's first voice (read above) does not cover: the structure itself and any other voice.
  const primary = staffOf(score);
  for (const part of score.parts) {
    ids.push(part.id);
    for (const staff of part.staves) {
      ids.push(staff.id);
      for (const staffBar of staff.bars) {
        for (const voice of staffBar.voices) {
          if (staff === primary && voice.index === FIRST_VOICE) continue;
          for (const item of voice.items) {
            ids.push(item.id);
            if (item.kind === 'note') for (const tone of item.stack ?? []) ids.push(tone.id);
            if (item.kind === 'note') for (const grace of item.graces ?? []) ids.push(grace.id);
          }
          for (const tuplet of voice.tuplets) ids.push(tuplet.id);
        }
      }
    }
  }
  for (const section of score.sections) ids.push(section.id);
  for (const spanner of score.spanners ?? []) ids.push(spanner.id);
  return ids;
}

/**
 * The next free id of a prefix in an existing score: one past the highest ordinal already used.
 *
 * A fresh `createIdFactory` counter is no good against a stored score, and "count the notes and
 * add one" collides the moment a note is removed. Taking the maximum cannot, and it is
 * deterministic given the document — though the op log does not lean on that, because the
 * applier records every id it generates (ADR-0003, ADR-0028).
 */
export function nextId(score: Score, prefix: IdPrefix): Id {
  let highest = 0;
  for (const id of idsOf(score)) {
    const parsed = parseId(id);
    if (parsed !== null && parsed.prefix === prefix && parsed.ordinal > highest) {
      highest = parsed.ordinal;
    }
  }
  return `${prefix}-${highest + 1}`;
}
