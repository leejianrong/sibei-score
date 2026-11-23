import type { Id, OctaveShift, Pitch, Score } from '@sibei/model';
import { barViews, orderedItems } from '@sibei/model';
import type { LayoutOttava } from './items.js';

/**
 * Ottava lines (SIB2-184). An 8va or 8vb is a `Spanner` of kind `ottava`; the notes it covers keep their
 * sounding pitch and are only *drawn* shifted, so the shift lives here, between the model and the ink.
 */

/** The pitch a note is drawn at: `up` (8va) writes it an octave lower than it sounds, `down` an octave higher. */
export function writtenPitch(pitch: Pitch, shift: OctaveShift | undefined): Pitch {
  if (shift === undefined) return pitch;
  return { ...pitch, octave: pitch.octave + (shift === 'up' ? -1 : 1) };
}

/** Every note an ottava line covers, with the shift it is under. Lines do not overlap, so it is one each. */
export function ottavaShifts(score: Score): Map<Id, OctaveShift> {
  const shifts = new Map<Id, OctaveShift>();
  const lines = (score.spanners ?? []).filter((spanner) => spanner.kind === 'ottava' && spanner.octaveShift !== undefined);
  if (lines.length === 0) return shifts;
  const order: Id[] = [];
  for (const bar of barViews(score)) {
    for (const item of orderedItems(bar)) if (item.kind === 'note') order.push(item.id);
  }
  for (const line of lines) {
    const from = order.indexOf(line.startId);
    const to = order.indexOf(line.endId);
    if (from === -1 || to === -1 || from > to || line.octaveShift === undefined) continue;
    for (const id of order.slice(from, to + 1)) shifts.set(id, line.octaveShift);
  }
  return shifts;
}

/**
 * The ottava lines on each system, by index. A line runs on every system from its first note's to its last
 * note's; a system it enters or leaves mid-way has a null end there, so the engraver runs the line to the
 * system edge (and a wrapped line carries on at the next system's music).
 */
export function planOttavas(score: Score, systemOfNote: Map<Id, number>): Map<number, LayoutOttava[]> {
  const bySystem = new Map<number, LayoutOttava[]>();
  for (const line of score.spanners ?? []) {
    if (line.kind !== 'ottava' || line.octaveShift === undefined) continue;
    const from = systemOfNote.get(line.startId);
    const to = systemOfNote.get(line.endId);
    if (from === undefined || to === undefined || from > to) continue;
    for (let system = from; system <= to; system += 1) {
      const entry: LayoutOttava = {
        id: line.id,
        shift: line.octaveShift,
        fromNoteId: system === from ? line.startId : null,
        toNoteId: system === to ? line.endId : null,
        labelled: system === from,
      };
      const list = bySystem.get(system);
      if (list === undefined) bySystem.set(system, [entry]);
      else list.push(entry);
    }
  }
  return bySystem;
}
