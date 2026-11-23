import type { Id, Score, Spanner } from '@sibei/model';
import type { Operation } from './api.js';
import { noteOrderByLane } from './lanes.js';

/**
 * The slur control's logic (SIB2-168), kept pure so a unit test can pin it. The browser selects a note,
 * shift-clicks a second one, and presses "Add slur": the two clicks can come in either order, so this puts
 * them in reading order (the server refuses a slur that runs backwards) and builds the `slur.set` op.
 *
 * Notes are addressed by id, which the ops accept anywhere an address goes (ADR-0007).
 */

/**
 * Reading-order index of every note within its own lane (a staff's voice), bar by bar. Rests are not in
 * it: a slur needs notes at both ends. A pair from two lanes has no order, so `ordered` answers null.
 */
function ordered(score: Score, a: Id, b: Id): { from: number; to: number } | null {
  const order = noteOrderByLane(score);
  const first = order.get(a);
  const second = order.get(b);
  if (first === undefined || second === undefined || first.lane !== second.lane) return null;
  return { from: first.at, to: second.at };
}

export type SlurChoice = 'auto' | 'above' | 'below';

/** The op that slurs the two notes, or null when either is not a note, or they are the same note. */
export function slurOp(score: Score, a: Id, b: Id, placement: SlurChoice): Operation | null {
  const pair = ordered(score, a, b);
  if (pair === null || pair.from === pair.to) return null;
  const { from, to } = pair;
  const [start, end] = from < to ? [a, b] : [b, a];
  return {
    type: 'slur.set',
    target: start,
    payload: placement === 'auto' ? { to: end } : { to: end, placement },
  };
}

/** The slurs that begin or end on a note, for the inspector to list and remove. */
export function slursOnNote(score: Score, noteId: Id): Spanner[] {
  return (score.spanners ?? []).filter(
    (spanner) => spanner.kind === 'slur' && (spanner.startId === noteId || spanner.endId === noteId),
  );
}

export function removeSlurOp(slurId: Id): Operation {
  return { type: 'slur.rm', target: slurId };
}

/** The op that puts an 8va (`up`) or 8vb (`down`) line over the run between two notes (SIB2-184), or null. */
export function ottavaOp(score: Score, a: Id, b: Id, shift: 'up' | 'down'): Operation | null {
  const pair = ordered(score, a, b);
  if (pair === null || pair.from === pair.to) return null;
  const { from, to } = pair;
  const [start, end] = from < to ? [a, b] : [b, a];
  return { type: 'ottava.set', target: start, payload: { to: end, shift } };
}

/** The ottava lines that cover a note, for the inspector to list and remove. */
export function ottavasOnNote(score: Score, noteId: Id): Spanner[] {
  const order = noteOrderByLane(score);
  const mine = order.get(noteId);
  if (mine === undefined) return [];
  return (score.spanners ?? []).filter((spanner) => {
    if (spanner.kind !== 'ottava') return false;
    const from = order.get(spanner.startId);
    const to = order.get(spanner.endId);
    return from !== undefined && to !== undefined && from.lane === mine.lane && from.at <= mine.at && mine.at <= to.at;
  });
}

export function removeOttavaOp(ottavaId: Id): Operation {
  return { type: 'ottava.rm', target: ottavaId };
}

/** The op that puts a crescendo or diminuendo wedge over the run between two notes (SIB2-274), or null. */
export function hairpinOp(score: Score, a: Id, b: Id, shape: 'crescendo' | 'diminuendo'): Operation | null {
  const pair = ordered(score, a, b);
  if (pair === null || pair.from === pair.to) return null;
  const { from, to } = pair;
  const [start, end] = from < to ? [a, b] : [b, a];
  return { type: 'hairpin.set', target: start, payload: { to: end, shape } };
}

/** The hairpins that cover a note, for the inspector to list and remove. */
export function hairpinsOnNote(score: Score, noteId: Id): Spanner[] {
  const order = noteOrderByLane(score);
  const mine = order.get(noteId);
  if (mine === undefined) return [];
  return (score.spanners ?? []).filter((spanner) => {
    if (spanner.kind !== 'hairpin') return false;
    const from = order.get(spanner.startId);
    const to = order.get(spanner.endId);
    return from !== undefined && to !== undefined && from.lane === mine.lane && from.at <= mine.at && mine.at <= to.at;
  });
}

export function removeHairpinOp(hairpinId: Id): Operation {
  return { type: 'hairpin.rm', target: hairpinId };
}
