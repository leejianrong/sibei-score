import { invalidBars, isMetricallyValid } from './metrics.js';
import type { Bar, Review, Score, TimeSignature } from './score.js';

/**
 * What "needs review" means, in one place, because more than one surface says it.
 *
 * The text projection has printed this sentence since V2e (ADR-0009). V4b's score rail has to
 * print the same one: **the engraver draws no indication of a flagged bar** — an under-filled bar
 * and a correct one are the same ink — so review state lives in the chrome or it is invisible, and
 * the chrome had better not invent its own vocabulary for it. Two surfaces wording the same fact
 * differently is the small version of the thing ADR-0002 exists to prevent.
 *
 * ## Where review state comes from, decided by KAN-597
 *
 * It used to come from two places at once. `anythingFlagged` read the **stored**
 * `bar.review.flagged`; `invalidBars` **derived** the same fact from the bar's contents. Nothing
 * kept them in step, so `reviewSummary(invalidBarChart())` answered `invalidBars: [1, 3]` and
 * `anythingFlagged: false` — and the score rail printed "Nothing flagged." over two invalid bars.
 * It looked fine because the applier stamps the flag on every write, so every chart authored
 * through the API was right and only hand-authored fixtures and imported documents were wrong:
 * correct exactly where anyone looked.
 *
 * The rule now is **one source per question, and the question decides the source**:
 *
 * - `metrically-invalid` is a pure function of a bar's items and the score's meter, so it is
 *   **always derived**, by every reader, through `barReview`. A stored copy of a derivable fact is
 *   a cache, and this one had already gone stale.
 * - `low-confidence`, `unparsed-chord` and `unrecognised-text` come out of the import pipeline
 *   (ADR-0011, ADR-0012) and **nothing can recompute them**, so a stored flag is the only possible
 *   source. That is not a second source of truth; it is a different question with its own single
 *   source.
 *
 * `makeBar` cannot help here, which is worth saying because it is the obvious alternative: metric
 * validity is a function of `(bar, score.meta.time)` and a bar is built without a meter, so no bar
 * constructor can derive it. Deriving at read is the only place it can be done from.
 *
 * The document still *carries* a `metrically-invalid` reason, written by the applier's `reflag`.
 * It is now a write-through cache that no reader consults, and removing it from the document is a
 * shape change owing a migration and a fixture (ADR-0028) — booked rather than smuggled in here.
 */

/** The `!` in the projection, spelled out. */
export const NEEDS_REVIEW = 'needs review';

/**
 * A bar's review state as a reader must see it: its stored reasons, with `metrically-invalid`
 * derived fresh from the bar's contents rather than read back out of the document.
 *
 * Every reader goes through this — `reviewSummary` and the projection's `bar12!` marker both do —
 * so the two cannot describe one bar differently. It is also what the applier writes, so the
 * stored copy cannot disagree in *rule* with the derived answer, only in age.
 */
export function barReview(bar: Bar, time: TimeSignature): Review {
  // Only the derivable reason is recomputed. The others are the import pipeline's and a rhythm has
  // no business clearing them.
  const stored = bar.review.reasons.filter((reason) => reason !== 'metrically-invalid');
  const reasons = isMetricallyValid(bar, time)
    ? stored
    : [...stored, 'metrically-invalid' as const];
  return { flagged: reasons.length > 0, reasons };
}

export interface ReviewSummary {
  /**
   * Whether anything at all carries a review flag — a bar, an item or a chord. Wider than
   * `invalidBars`, because an imported chart can flag a note or a chord symbol on its own
   * (ADR-0011, ADR-0013) without any bar failing to fill the meter.
   */
  anythingFlagged: boolean;
  /**
   * Bar numbers that do not fill the meter, in bar order (ADR-0013). An **empty** bar is not one
   * of them: a blank chart is the normal starting state, so it is not a review case at all
   * (KAN-597, and the reasoning is in `metrics.ts`).
   */
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
      barReview(bar, score.meta.time).flagged ||
      bar.items.some((item) => item.review.flagged) ||
      bar.chords.some((chord) => chord.review.flagged),
  );
}
