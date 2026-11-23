import type { BarView, Score } from '@sibei/model';
import { gridBars, pickupBar, startsSection } from '@sibei/model';

/**
 * The four-bar grid (ADR-0015). Four bars per line by default (`meta.barsPerSystem` changes the
 * count); a section boundary breaks the line even mid-grid, so an 11-bar section lays out 4 / 4 / 3.
 * A bar's `lineBreak` overrides both: `after` ends the line, `join` lets a section share one. A pickup
 * sits before bar 1 on the first line and consumes no slot.
 */

export const BARS_PER_SYSTEM = 4;

export interface PlannedSystem {
  /** Present only on the first system of the score. */
  pickup: BarView | null;
  /** One to four bars that occupy grid slots. */
  bars: BarView[];
}

/**
 * What `meta.layout: 'score'` needs to break a line by width (SIB2-227): the room a line has, and what a bar needs there
 * (its content floor, with the clef and key signature when it heads the line). Layout supplies it; the grid never
 * measures anything itself.
 */
export interface FitOptions {
  available: number;
  barWidth: (bar: BarView, headsSystem: boolean) => number;
}

export function planSystems(score: Score, fit?: FitOptions): PlannedSystem[] {
  const pickup = pickupBar(score);
  const rows: BarView[][] = [];
  let current: BarView[] = [];

  // `score` breaks a line when the next bar would not fit it; `lead-sheet` (the default) is the grid below, untouched.
  const byWidth = score.meta.layout === 'score' && fit !== undefined;
  let used = byWidth && pickup !== null ? fit.barWidth(pickup, true) : 0;
  const perSystem = score.meta.barsPerSystem ?? BARS_PER_SYSTEM;
  for (const bar of gridBars(score)) {
    const needed = byWidth ? fit.barWidth(bar, current.length === 0) : 0;
    const overfull = byWidth ? current.length > 0 && used + needed > fit.available : current.length >= perSystem;
    // A section forces a break unless that bar was told to `join` the line (SIB2-174); a bar marked
    // `after` ends its line wherever it falls.
    const wouldBreakForSection =
      current.length > 0 && startsSection(score, bar.number) && bar.lineBreak !== 'join';
    const previousEndsLine = current[current.length - 1]?.lineBreak === 'after';
    if (overfull || wouldBreakForSection || previousEndsLine) {
      rows.push(current);
      current = [];
      used = 0;
    }
    used += byWidth ? fit.barWidth(bar, current.length === 0) : 0;
    current.push(bar);
  }
  if (current.length > 0) rows.push(current);

  if (rows.length === 0) {
    // A score with a pickup and nothing else still has one line to draw.
    return pickup === null ? [] : [{ pickup, bars: [] }];
  }

  return rows.map((bars, index) => ({ pickup: index === 0 ? pickup : null, bars }));
}
