import type { Bar, Score } from '@sibei/model';
import { gridBars, pickupBar, startsSection } from '@sibei/model';

/**
 * The four-bar grid (ADR-0015). Four bars per line by default; a section boundary
 * breaks the line even mid-grid, so an 11-bar section lays out 4 / 4 / 3. A pickup
 * sits before bar 1 on the first line and consumes no slot.
 */

export const BARS_PER_SYSTEM = 4;

export interface PlannedSystem {
  /** Present only on the first system of the score. */
  pickup: Bar | null;
  /** One to four bars that occupy grid slots. */
  bars: Bar[];
}

export function planSystems(score: Score): PlannedSystem[] {
  const pickup = pickupBar(score);
  const rows: Bar[][] = [];
  let current: Bar[] = [];

  for (const bar of gridBars(score)) {
    const wouldBreakForSection = current.length > 0 && startsSection(score, bar.number);
    if (current.length === BARS_PER_SYSTEM || wouldBreakForSection) {
      rows.push(current);
      current = [];
    }
    current.push(bar);
  }
  if (current.length > 0) rows.push(current);

  if (rows.length === 0) {
    // A score with a pickup and nothing else still has one line to draw.
    return pickup === null ? [] : [{ pickup, bars: [] }];
  }

  return rows.map((bars, index) => ({ pickup: index === 0 ? pickup : null, bars }));
}
