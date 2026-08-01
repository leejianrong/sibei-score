import { invalidBars } from './metrics.js';
import type { Score } from './score.js';

/**
 * What "needs review" means, in one place, because more than one surface says it.
 *
 * The text projection has printed this sentence since V2e (ADR-0009). V4b's score rail has to
 * print the same one: **the engraver draws no indication of a flagged bar** — an under-filled bar
 * and a correct one are the same ink — so review state lives in the chrome or it is invisible, and
 * the chrome had better not invent its own vocabulary for it. Two surfaces wording the same fact
 * differently is the small version of the thing ADR-0002 exists to prevent.
 *
 * It is also why this is a function rather than a string the UI copies. KAN-597 changes how a blank
 * chart reports review state at the model level — today every empty bar is "does not fill the
 * meter", so a fresh 32-bar chart is 100% flagged and says so twice. When that changes, this file
 * changes, and both surfaces follow without being touched.
 */

/** The `!` in the projection, spelled out. */
export const NEEDS_REVIEW = 'needs review';

export interface ReviewSummary {
  /**
   * Whether anything at all carries a review flag — a bar, an item or a chord. Wider than
   * `invalidBars`, because an imported chart can flag a note or a chord symbol on its own
   * (ADR-0011, ADR-0013) without any bar failing to fill the meter.
   */
  anythingFlagged: boolean;
  /** Bar numbers that do not fill the meter, in bar order (ADR-0013). */
  invalidBars: number[];
  /** `32 bars do not fill the meter`, `1 bar does not fill the meter`, or null. */
  meterNote: string | null;
}

export function reviewSummary(score: Score): ReviewSummary {
  const invalid = invalidBars(score).map((metrics) => metrics.barNumber);
  return {
    anythingFlagged: anythingFlagged(score),
    invalidBars: invalid,
    meterNote: invalid.length === 0 ? null : meterNote(invalid.length),
  };
}

/**
 * The verb agrees with the count. It did not before: the projection pluralised the noun and left
 * `do` alone, so one short bar produced "1 bar do not fill the meter". No test pinned it and
 * CLAUDE.md's own worked example already prints the grammatical form — so the doc was right, the
 * code was wrong, and the divergence survived because the singular case never appeared in a
 * fixture. It is fixed here rather than papered over, because the score rail now reads this
 * sentence aloud in the chrome (V4b) and a projection contract is worth being able to quote.
 */
function meterNote(count: number): string {
  return count === 1
    ? '1 bar does not fill the meter'
    : `${count} bars do not fill the meter`;
}

function anythingFlagged(score: Score): boolean {
  return score.bars.some(
    (bar) =>
      bar.review.flagged ||
      bar.items.some((item) => item.review.flagged) ||
      bar.chords.some((chord) => chord.review.flagged),
  );
}
