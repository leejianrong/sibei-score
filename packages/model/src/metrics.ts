import { barCapacity, itemTicks } from './duration.js';
import type { Bar, Score, TimeSignature } from './score.js';

/**
 * Metric validity is a derived, always-computable property, never an invariant
 * (ADR-0013). A bar whose durations do not sum to the meter is stored as-is and
 * flagged. Nothing in this file rejects, repairs, or refuses anything.
 */

/**
 * `empty` is a bar nobody has written yet, and it is deliberately its own status rather
 * than the smallest case of `under` (KAN-597). The enum had no way to say "there is no
 * rhythm here", so an empty bar was indistinguishable from a wrong one — and since a
 * blank chart is every chart's starting state, that made "does not fill the meter" fire
 * on 100% of new documents.
 */
export type MetricStatus = 'empty' | 'exact' | 'under' | 'over';

export interface BarMetrics {
  barNumber: number;
  /** Ticks a full bar of this meter holds. */
  expected: number;
  /** Ticks the bar's items actually sum to. */
  actual: number;
  status: MetricStatus;
  /**
   * Whether the bar is acceptable as written — i.e. whether there is nothing here to
   * review. Identical to `status === 'exact'` but for two cases: an empty bar, which has
   * no rhythm to be wrong about, and a pickup, which is expected to be short.
   */
  valid: boolean;
}

export function barMetrics(bar: Bar, time: TimeSignature): BarMetrics {
  const expected = barCapacity(time);
  const actual = bar.items.reduce((sum, item) => sum + itemTicks(item, bar), 0);
  const status: MetricStatus =
    actual === 0 ? 'empty' : actual === expected ? 'exact' : actual < expected ? 'under' : 'over';
  return { barNumber: bar.number, expected, actual, status, valid: isValid(bar, actual, expected) };
}

/**
 * An empty bar is valid, whichever bar it is. A pickup (bar 0) is valid when it is short,
 * because being short is the whole point of one. Every other bar must sum exactly.
 *
 * **The empty case is KAN-597's decision**, and the argument is that ADR-0013 is not about
 * it. That ADR is about a rhythm the system disagrees with — the imported bar whose
 * durations are wrong, the bar caught mid-edit — and its reasoning is that repairing or
 * refusing one would force a guess. An empty bar is not a rhythm the system disagrees
 * with; it is the absence of one, and nothing about it needs a human's judgement. Since a
 * blank 32-bar chart is the normal starting state of every chart, calling it 32 problems
 * is a review signal that has stopped signalling.
 *
 * Nothing here changes what is *stored*: ADR-0013 still holds in full and an empty bar is
 * kept exactly as written. This changes only how a bar is described.
 *
 * **The empty pickup goes with it**, and that overturns an earlier deliberate decision
 * here — bar 0 used to require `actual > 0`, on the reasoning that a pickup exists in
 * order to hold something. What defeats that is `sbscore new --pickup`, an ordinary thing
 * to ask for: it opens bar 0 with nothing in it, so an empty pickup is a *starting state*
 * and not a broken document. One rule for every bar also means one rule to remember. An
 * empty pickup that is genuinely a mistake is a structural oddity rather than a metric
 * one, and this file is about metres; nothing detects structural oddities today.
 */
function isValid(bar: Bar, actual: number, expected: number): boolean {
  if (actual === 0) return true;
  if (bar.number === 0) return actual <= expected;
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
