import { barCapacity, itemTicks } from './duration.js';
import type { Bar, Score, TimeSignature } from './score.js';

/**
 * Metric validity is a derived, always-computable property, never an invariant
 * (ADR-0013). A bar whose durations do not sum to the meter is stored as-is and
 * flagged. Nothing in this file rejects, repairs, or refuses anything.
 */

export type MetricStatus = 'exact' | 'under' | 'over';

export interface BarMetrics {
  barNumber: number;
  /** Ticks a full bar of this meter holds. */
  expected: number;
  /** Ticks the bar's items actually sum to. */
  actual: number;
  status: MetricStatus;
  /**
   * Whether the bar is acceptable as written. Identical to `status === 'exact'`
   * except for a pickup, which is expected to be short.
   */
  valid: boolean;
}

export function barMetrics(bar: Bar, time: TimeSignature): BarMetrics {
  const expected = barCapacity(time);
  const actual = bar.items.reduce((sum, item) => sum + itemTicks(item, bar), 0);
  const status: MetricStatus = actual === expected ? 'exact' : actual < expected ? 'under' : 'over';
  return { barNumber: bar.number, expected, actual, status, valid: isValid(bar, actual, expected) };
}

/**
 * A pickup bar (bar 0) is valid when it is non-empty and does not overflow the
 * meter — being short is the whole point of one. Every other bar must sum exactly.
 */
function isValid(bar: Bar, actual: number, expected: number): boolean {
  if (bar.number === 0) return actual > 0 && actual <= expected;
  return actual === expected;
}

export function isMetricallyValid(bar: Bar, time: TimeSignature): boolean {
  return barMetrics(bar, time).valid;
}

/** Every bar's metrics, in bar order. Consumers decide what to do about them. */
export function scoreMetrics(score: Score): BarMetrics[] {
  return score.bars.map((bar) => barMetrics(bar, score.meta.time));
}

/** The bars a human or an agent should be pointed at. */
export function invalidBars(score: Score): BarMetrics[] {
  return scoreMetrics(score).filter((m) => !m.valid);
}
