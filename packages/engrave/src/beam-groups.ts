import type { Id, TimeSignature } from '@sibei/model';
import { TICKS_PER_QUARTER, TICKS_PER_WHOLE, beatTicks } from '@sibei/model';

/**
 * Which notes share a beam (SIB2-154). Pure: it sees onsets and durations, never glyphs, so every
 * rule below is testable without an engraver. Gould's *Behind Bars* (the beaming chapter) and jazz
 * lead-sheet practice, in the order they are applied:
 *
 * 1. **A group is a beat.** Beamable notes (eighth or shorter) share a beam while they sit in one beat
 *    of the time signature: a quarter in 4/4, 3/4 and 2/4, a half in cut time (2/2), a dotted quarter
 *    in compound metre (6/8, 9/8, 12/8, 3/8).
 * 2. **4/4 may join its half bars.** When the four notes of a half bar are all plain eighths, they take
 *    one beam, never across the middle of the bar (beat 2 to beat 3). One sixteenth, dot, rest or
 *    tuplet in the half bar puts it back to beats, so the beaming still shows where the beat falls.
 * 3. **A rest breaks a group.** Jazz style: the rhythm is read off the beams, so none runs over a rest.
 *    A note too long to beam (a quarter or longer) breaks it too.
 * 4. **A tuplet is never split.** Its members stay together even where it straddles a beat line, and a
 *    group never mixes tuplet and plain notes, nor two different tuplets.
 * 5. **Secondary beams break at the sub-beat** (a quarter in 2/2, an eighth in 6/8), so a long run of
 *    sixteenths still shows its pulse. See `secondaryBreaks`.
 */

export interface BeamCandidate {
  kind: 'note' | 'rest';
  onset: number;
  /** An eighth or shorter, a note. */
  beamable: boolean;
  /** An undotted eighth: the only thing a half-bar join takes. */
  plainEighth: boolean;
  tupletId: Id | null;
}

const EPSILON = 1e-6;

function isCompound(time: TimeSignature): boolean {
  return time.beatValue === 8 && time.beats % 3 === 0;
}

/** The span one group may cover. */
export function groupTicks(time: TimeSignature): number {
  return isCompound(time) ? (TICKS_PER_WHOLE / 8) * 3 : beatTicks(time);
}

/** The span a secondary (second and deeper) beam may cover unbroken. */
export function subBeatTicks(time: TimeSignature): number {
  return isCompound(time) ? TICKS_PER_WHOLE / 8 : Math.min(beatTicks(time), TICKS_PER_QUARTER);
}

function slot(onset: number, ticks: number): number {
  return Math.floor(onset / ticks + EPSILON);
}

/** 4/4 only: the half bar is the wider unit eighths may join over. */
function halvesBar(time: TimeSignature): boolean {
  return time.beats === 4 && time.beatValue === 4;
}

/** Groups as arrays of indices into `items`, each of two or more notes, in order. */
export function beamGroupIndices(
  items: readonly BeamCandidate[],
  time: TimeSignature,
): number[][] {
  const ticks = groupTicks(time);

  // The slot all of a tuplet's members are counted in: wherever its first member starts.
  const tupletSlot = new Map<Id, number>();
  for (const item of items) {
    if (item.tupletId !== null && !tupletSlot.has(item.tupletId)) {
      tupletSlot.set(item.tupletId, slot(item.onset, ticks));
    }
  }
  const slotOf = (item: BeamCandidate): number =>
    item.tupletId === null ? slot(item.onset, ticks) : (tupletSlot.get(item.tupletId) ?? 0);

  const groups: number[][] = [];
  let current: number[] = [];
  let currentSlot = -1;
  let currentTuplet: Id | null = null;

  const flush = (): void => {
    if (current.length > 1) groups.push(current);
    current = [];
  };

  items.forEach((item, index) => {
    if (item.kind !== 'note' || !item.beamable) {
      flush();
      currentSlot = -1;
      return;
    }
    const itemSlot = slotOf(item);
    if (itemSlot !== currentSlot || item.tupletId !== currentTuplet) {
      flush();
      currentSlot = itemSlot;
      currentTuplet = item.tupletId;
    }
    current.push(index);
  });
  flush();

  return halvesBar(time) ? joinHalfBars(items, groups, beatTicks(time) * 2) : groups;
}

/** Merge the two beat groups of a half bar when that half is exactly four plain eighths in a row. */
function joinHalfBars(
  items: readonly BeamCandidate[],
  groups: readonly number[][],
  half: number,
): number[][] {
  const out: number[][] = [];
  for (let at = 0; at < groups.length; at += 1) {
    const first = groups[at];
    const second = groups[at + 1];
    if (first !== undefined && second !== undefined && joinable(items, first, second, half)) {
      out.push([...first, ...second]);
      at += 1;
    } else if (first !== undefined) {
      out.push(first);
    }
  }
  return out;
}

function joinable(
  items: readonly BeamCandidate[],
  first: readonly number[],
  second: readonly number[],
  half: number,
): boolean {
  if (first.length !== 2 || second.length !== 2) return false;
  const lastOfFirst = first[1];
  const firstOfSecond = second[0];
  if (lastOfFirst === undefined || firstOfSecond === undefined) return false;
  if (firstOfSecond !== lastOfFirst + 1) return false;
  const all = [...first, ...second].map((index) => items[index]);
  if (all.some((item) => item === undefined || !item.plainEighth || item.tupletId !== null)) {
    return false;
  }
  const a = all[0];
  const d = all[3];
  if (a === undefined || d === undefined) return false;
  return slot(a.onset, half) === slot(d.onset, half);
}

/**
 * For each member of a group (by onset), whether a secondary beam must break before it: it starts a
 * new sub-beat. The first member never breaks.
 */
export function secondaryBreaks(onsets: readonly number[], time: TimeSignature): boolean[] {
  const ticks = subBeatTicks(time);
  return onsets.map((onset, index) => {
    const before = onsets[index - 1];
    return before !== undefined && slot(onset, ticks) !== slot(before, ticks);
  });
}
