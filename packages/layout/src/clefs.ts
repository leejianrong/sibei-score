import type { Clef, Id, Score, Staff } from '@sibei/model';
import { allStaves } from '@sibei/model';

/**
 * Clef changes (ADR-0041, SIB2-241). A staff opens in `Staff.clef`; `StaffBar.clef` at a bar changes it from that bar's
 * start until the next change. A change to the clef already in force is not a change, so nothing is drawn for it.
 */

/** The clef in force at the start of a bar: the last change at or before it, else the staff's opening clef. */
export function effectiveClef(score: Score, staff: Staff, barId: Id): Clef {
  let current = staff.clef;
  for (const bar of score.bars) {
    const set = staff.bars.find((candidate) => candidate.barId === bar.id)?.clef;
    if (set !== undefined) current = set;
    if (bar.id === barId) return current;
  }
  return current;
}

/** The clef this staff changes to at the bar, or null when it keeps the clef it had. */
export function clefChangeOf(score: Score, staff: Staff, barId: Id): Clef | null {
  const set = staff.bars.find((candidate) => candidate.barId === barId)?.clef;
  if (set === undefined) return null;
  const index = score.bars.findIndex((bar) => bar.id === barId);
  const before = index <= 0 ? staff.clef : effectiveClef(score, staff, score.bars[index - 1]!.id);
  return set === before ? null : set;
}

/** Whether any staff changes clef at the start of this bar. */
export function clefChangesAt(score: Score, barId: Id): boolean {
  return allStaves(score).some((staff) => clefChangeOf(score, staff, barId) !== null);
}

/** Whether a staff changes clef anywhere, so its ink must be measured bar by bar. */
export function hasClefChanges(score: Score, staff: Staff): boolean {
  return staff.bars.some((bar) => clefChangeOf(score, staff, bar.barId) !== null);
}
