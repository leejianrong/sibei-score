import { allBarViews, allStaves, voiceIndexes } from '@sibei/model';
import type { BarItem, Clef, Id, Score, Tuplet } from '@sibei/model';

/**
 * Which staff and voice an edit is for (ADR-0041, slice 5b). A **lane** is one voice of one staff,
 * numbered the way the address grammar numbers it: the staff counts across parts in order from 1, the
 * voice is its 1-based index. The browser holds one as the *active lane* and attaches it to every
 * edit it makes by position (`s2.v2.bar12.beat3`); an edit of an existing note goes by id, which the
 * ops resolve anywhere, so it needs no qualifier.
 */
export interface Lane {
  staff: number;
  voice: number;
}

export const FIRST_LANE: Lane = { staff: 1, voice: 1 };

/**
 * Whether an address by position has to carry a qualifier. ADR-0041 is strict: with more than one staff,
 * or a staff with more than one voice (even an empty one), an unqualified address is `ambiguous`. A
 * chart with one of each is addressed exactly as it always was, so a lead sheet's ops are unchanged.
 */
export function needsQualifier(score: Score): boolean {
  const staves = allStaves(score);
  return staves.length > 1 || staves.some((staff) => voiceIndexes(staff).length > 1);
}

/** `s2.v2.` for a chart that needs it, `''` for one that does not. */
export function qualifierOf(score: Score, lane: Lane): string {
  return needsQualifier(score) ? `s${lane.staff}.v${lane.voice}.` : '';
}

/** A lane kept inside what the score has: a staff that is gone falls back to the last, a voice to 1. */
export function clampLane(score: Score, lane: Lane): Lane {
  const staves = allStaves(score);
  const staff = Math.min(Math.max(lane.staff, 1), Math.max(staves.length, 1));
  const there = staves[staff - 1];
  const present = there === undefined ? [1] : voiceIndexes(there);
  return { staff, voice: present.includes(lane.voice) ? lane.voice : 1 };
}

/** The clef a staff opens with, for labels. */
export function staffClef(score: Score, staff: number): Clef | null {
  return allStaves(score)[staff - 1]?.clef ?? null;
}

/** `Staff 2 · bass · Voice 2`, for the status line and the inspector. */
export function laneLabel(score: Score, lane: Lane): string {
  const clef = staffClef(score, lane.staff);
  return `Staff ${lane.staff}${clef === null ? '' : ` · ${clef}`} · Voice ${lane.voice}`;
}

/** Every item of the chart with the lane it sits in, bar by bar: what a lookup by id walks. */
function* itemsWithLane(score: Score): Generator<{ lane: Lane; item: BarItem; tuplets: readonly Tuplet[] }> {
  const staffIds = allStaves(score).map((staff) => staff.id);
  for (const { select, views } of allBarViews(score)) {
    const staff = staffIds.indexOf(select.staff) + 1;
    for (const view of views) {
      for (const item of view.items) {
        yield { lane: { staff, voice: select.voice }, item, tuplets: view.tuplets };
      }
    }
  }
}

/** The lane an item (note or rest) sits in, from the stored score. */
export function laneOfItem(score: Score, id: Id): Lane | null {
  for (const found of itemsWithLane(score)) if (found.item.id === id) return found.lane;
  return null;
}

/** The tuplet an item sits in, on any staff or voice. */
export function tupletOf(score: Score, id: Id): Tuplet | null {
  for (const found of itemsWithLane(score)) {
    if (found.item.id !== id) continue;
    return found.tuplets.find((t) => t.memberIds.includes(id)) ?? null;
  }
  return null;
}

/** A note's spelling pin, on any staff or voice. */
export function notePinnedIn(score: Score, id: Id): boolean {
  for (const found of itemsWithLane(score)) {
    if (found.item.id === id && found.item.kind === 'note') return found.item.spellingPinned;
  }
  return false;
}

/**
 * Every note in reading order within its own lane, for the slur and ottava controls: a slur joins two
 * notes of one voice, so a pair from two lanes has no order and the control stays off.
 */
export function noteOrderByLane(score: Score): Map<Id, { lane: string; at: number }> {
  const order = new Map<Id, { lane: string; at: number }>();
  for (const { select, views } of allBarViews(score)) {
    const lane = `${select.staff}.${select.voice}`; // the staff id and the voice: a key, never shown
    let at = 0;
    for (const view of views) {
      for (const item of [...view.items].sort((a, b) => a.onset - b.onset)) {
        if (item.kind === 'note') order.set(item.id, { lane, at: at++ });
      }
    }
  }
  return order;
}
