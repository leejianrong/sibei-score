import { barViews } from './staves.js';
import type { BarView, Note, Score, Section } from './score.js';

/** Read-only helpers over a score. No mutation lives here (ADR-0003). */

/** A pickup is bar 0 and is always the first bar when present (ADR-0007). */
export function pickupBar(score: Score): BarView | null {
  const first = barViews(score)[0];
  return first !== undefined && first.number === 0 ? first : null;
}

export function hasPickup(score: Score): boolean {
  return pickupBar(score) !== null;
}

/** Bars that occupy a slot in the four-bar grid, i.e. everything but the pickup. */
export function gridBars(score: Score): BarView[] {
  return barViews(score).filter((bar) => bar.number !== 0);
}

export function barByNumber(score: Score, number: number): BarView | null {
  return barViews(score).find((bar) => bar.number === number) ?? null;
}

/** The section beginning on this bar, when one does. */
export function sectionStartingAt(score: Score, barNumber: number): Section | null {
  return score.sections.find((section) => section.startBar === barNumber) ?? null;
}

export function startsSection(score: Score, barNumber: number): boolean {
  return sectionStartingAt(score, barNumber) !== null;
}

export function notesOf(bar: BarView): Note[] {
  return bar.items.filter((item): item is Note => item.kind === 'note');
}

/**
 * Every note in the score with the bar it sits in, in reading order. Ties span bars,
 * so consumers of tie roles need this rather than a per-bar view.
 */
export function notesInReadingOrder(score: Score): { bar: BarView; note: Note }[] {
  const result: { bar: BarView; note: Note }[] = [];
  for (const bar of barViews(score)) {
    for (const note of notesOf(bar)) result.push({ bar, note });
  }
  return result;
}
