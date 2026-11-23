import type { Id, OctaveShift, Pitch, Score } from '@sibei/model';
import { allStaves, barView, barViews, orderedItems } from '@sibei/model';
import { isMultiLane, voiceViewsOf } from './lanes.js';
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
  // A multi-staff score keeps a line on its own staff: each staff is its own reading order, voices merged by onset
  // (SIB2-233; before it, only the top staff's notes could be under a line). A single-staff chart is unchanged.
  const orders: Id[][] = [];
  if (isMultiLane(score)) {
    for (const staff of allStaves(score)) {
      const entries: { bar: number; onset: number; voice: number; id: Id }[] = [];
      score.bars.forEach((bar, barIndex) => {
        for (const voice of voiceViewsOf(score, staff, barView(score, bar))) {
          for (const item of orderedItems(voice.view)) {
            if (item.kind === 'note') entries.push({ bar: barIndex, onset: item.onset, voice: voice.index, id: item.id });
          }
        }
      });
      entries.sort((a, b) => a.bar - b.bar || a.onset - b.onset || a.voice - b.voice);
      orders.push(entries.map((entry) => entry.id));
    }
  } else {
    const order: Id[] = [];
    for (const bar of barViews(score)) {
      for (const item of orderedItems(bar)) if (item.kind === 'note') order.push(item.id);
    }
    orders.push(order);
  }
  for (const line of lines) {
    if (line.octaveShift === undefined) continue;
    for (const order of orders) {
      const from = order.indexOf(line.startId);
      const to = order.indexOf(line.endId);
      if (from === -1 || to === -1 || from > to) continue;
      for (const id of order.slice(from, to + 1)) shifts.set(id, line.octaveShift);
      break;
    }
  }
  return shifts;
}

/**
 * The ottava lines on each system, by index. A line runs on every system from its first note's to its last
 * note's; a system it enters or leaves mid-way has a null end there, so the engraver runs the line to the
 * system edge (and a wrapped line carries on at the next system's music).
 */
export function planOttavas(
  score: Score,
  systemOfNote: Map<Id, number>,
  staffOfNote?: ReadonlyMap<Id, number>,
): Map<number, LayoutOttava[]> {
  const bySystem = new Map<number, LayoutOttava[]>();
  for (const line of score.spanners ?? []) {
    if (line.kind !== 'ottava' || line.octaveShift === undefined) continue;
    const from = systemOfNote.get(line.startId);
    const to = systemOfNote.get(line.endId);
    if (from === undefined || to === undefined || from > to) continue;
    // A line belongs to the staff of its first note; only a staff below the top one is named (SIB2-233).
    const staff = staffOfNote?.get(line.startId) ?? 0;
    for (let system = from; system <= to; system += 1) {
      const entry: LayoutOttava = {
        id: line.id,
        shift: line.octaveShift,
        fromNoteId: system === from ? line.startId : null,
        toNoteId: system === to ? line.endId : null,
        labelled: system === from,
        ...(staff > 0 ? { staff } : {}),
      };
      const list = bySystem.get(system);
      if (list === undefined) bySystem.set(system, [entry]);
      else list.push(entry);
    }
  }
  return bySystem;
}
