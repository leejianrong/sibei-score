import { allBarViews, barViews } from './staves.js';
import { invalidBars, isMetricallyValid } from './metrics.js';
import { beatOfOnset } from './duration.js';
import type { BarView, Review, ReviewReason, Score, TimeSignature } from './score.js';

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
 * The document used to still *carry* a `metrically-invalid` reason, written by the applier's
 * `reflag` — a write-through cache no reader consulted. **KAN-610 dropped it**: the applier no
 * longer writes the reason at all, a v2 -> v3 migration carries an older document's stale copy away
 * (ADR-0028, `migrate.ts`'s `DROP_METRICALLY_INVALID`), and `barReview` below is now the only place
 * the reason exists, for a stored document or an in-memory one alike.
 */

/** The `!` in the projection, spelled out. */
export const NEEDS_REVIEW = 'needs review';

/**
 * The **no-sections advisory** (V14, ADR-0015), worded once here because both surfaces say it.
 *
 * Sections drive line-breaking: a section boundary forces a line break even mid-grid (ADR-0015),
 * so a chart *with* sections lays out at the form and a chart *without* them lays out on a plain
 * four-bar grid. A fresh import detects no sections (ADR-0021), which is the sharpest case — the
 * layout is provisional until the user supplies them — but the fact is a property of the score, not
 * of how it was made, so the predicate is `reviewSummary(...).hasSections` and the advisory fires
 * for any section-less chart.
 *
 * It is an **advisory, not a review flag**: nothing is wrong (ADR-0013/0019 never refuse or repair a
 * draft), the layout is simply not yet broken at the form. So it lives beside `NEEDS_REVIEW` rather
 * than inside it, and both surfaces print *this* string rather than inventing their own — the same
 * one-source rule that keeps the review line from being worded two ways (ADR-0002).
 */
export const NO_SECTIONS_ADVISORY =
  'no sections yet — laid out on a plain four-bar grid; add one to break the line at the form';

/**
 * A bar's review state as a reader must see it: its stored reasons, with `metrically-invalid`
 * derived fresh from the bar's contents rather than read back out of the document.
 *
 * Every reader goes through this — `reviewSummary` and the projection's `bar12!` marker both do —
 * so the two cannot describe one bar differently. Since KAN-610 the applier does not store this
 * reason at all (see `reflag` in `packages/api/src/ops/apply.ts`), so `stored` below is normally
 * just a bar's *other* reasons already — the filter is a no-op on a current document and a safety
 * net for one that has not been migrated yet.
 */
export function barReview(bar: BarView, time: TimeSignature): Review {
  // Only the derivable reason is recomputed. The others are the import pipeline's and a rhythm has
  // no business clearing them.
  const stored = bar.review.reasons.filter((reason) => reason !== 'metrically-invalid');
  const reasons = isMetricallyValid(bar, time)
    ? stored
    : [...stored, 'metrically-invalid' as const];
  return { flagged: reasons.length > 0, reasons };
}

/**
 * `barReview` for a bar of a whole score: flagged when *any* voice of any staff does not fill it (ADR-0041
 * section 3; an empty voice is allowed). For a one-staff, one-voice score this is `barReview` exactly.
 */
export function scoreBarReview(score: Score, bar: BarView): Review {
  const voices = allBarViews(score);
  if (voices.length <= 1) return barReview(bar, score.meta.time);
  const at = score.bars.findIndex((candidate) => candidate.id === bar.id);
  const stored = bar.review.reasons.filter((reason) => reason !== 'metrically-invalid');
  const invalid = voices.some(({ views }) => at >= 0 && !isMetricallyValid(views[at]!, score.meta.time));
  const reasons = invalid ? [...stored, 'metrically-invalid' as const] : stored;
  return { flagged: reasons.length > 0, reasons };
}

export interface ReviewSummary {
  /**
   * Whether anything at all carries a review flag — a bar, an item, a chord or an annotation.
   * Wider than `invalidBars`, because an imported chart can flag a note, a chord symbol or a piece
   * of non-chord text on its own (ADR-0011, ADR-0013) without any bar failing to fill the meter.
   */
  anythingFlagged: boolean;
  /**
   * BarView numbers that do not fill the meter, in bar order (ADR-0013). An **empty** bar is not one
   * of them: a blank chart is the normal starting state, so it is not a review case at all
   * (KAN-597, and the reasoning is in `metrics.ts`).
   */
  invalidBars: number[];
  /** `32 bars do not fill the meter`, `1 bar does not fill the meter`, or null. */
  meterNote: string | null;
  /**
   * Whether the score carries at least one section (V7 structure). **False** on a fresh import
   * (ADR-0021) and on a blank `sbscore new` chart, which is when the no-sections advisory fires:
   * sections drive line-breaking (ADR-0015), so a section-less chart lays out on a plain four-bar
   * grid until the user adds one. Derived here rather than per surface so the two cannot disagree
   * about whether the advisory should show (`NO_SECTIONS_ADVISORY`).
   */
  hasSections: boolean;
  /**
   * Whether the surfaces print `NO_SECTIONS_ADVISORY` (SIB2-238): no sections **and** a lead-sheet layout. A
   * `meta.layout: 'score'` chart breaks systems by width (ADR-0041 section 5), not on the four-bar grid, so the
   * advisory's claim is false there. One answer, so the two surfaces cannot disagree.
   */
  showNoSectionsAdvisory: boolean;
}

export function reviewSummary(score: Score): ReviewSummary {
  const invalid = invalidBars(score).map((metrics) => metrics.barNumber);
  return {
    anythingFlagged: anythingFlagged(score),
    invalidBars: invalid,
    meterNote: invalid.length === 0 ? null : meterNote(invalid.length),
    hasSections: score.sections.length > 0,
    showNoSectionsAdvisory: score.sections.length === 0 && score.meta.layout !== 'score',
  };
}

/**
 * The verb agrees with the count. It did not before: the projection pluralised the noun and left
 * `do` alone, so one short bar produced "1 bar do not fill the meter". No test pinned it and
 * the projection's own worked example (`agent_docs/surfaces.md`) already prints the grammatical
 * form — so the doc was right, the
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
  return barViews(score).some(
    (bar) =>
      scoreBarReview(score, bar).flagged ||
      bar.items.some((item) => item.review.flagged) ||
      bar.chords.some((chord) => chord.review.flagged) ||
      bar.annotations.some((annotation) => annotation.review.flagged),
  ) || otherVoicesFlagged(score);
}

/** A flagged note or rest in any voice but the first staff's first (which `barViews` reads). */
function otherVoicesFlagged(score: Score): boolean {
  return allBarViews(score)
    .slice(1)
    .some(({ views }) => views.some((bar) => bar.items.some((item) => item.review.flagged)));
}

/** One flagged thing in a chart, as `sbscore check` lists it (SIB2-193). */
export interface FlaggedObject {
  /** An address the CLI accepts: `bar5` for a whole bar, `bar5.beat2` for something at a beat. */
  address: string;
  kind: 'bar' | 'note' | 'rest' | 'chord' | 'annotation';
  /** The object's own id, where it has one distinct from the address. */
  id: string | null;
  /** Chord or annotation text; null otherwise. */
  text: string | null;
  reasons: ReviewReason[];
}

/**
 * Every flagged object, in bar order. The same sources `anythingFlagged` reads — a bar's derived
 * review, and the stored review on items, chords and annotations — so `check` and `show`'s `!`
 * cannot disagree about what is flagged.
 */
export function flaggedObjects(score: Score): FlaggedObject[] {
  const time = score.meta.time;
  const found: FlaggedObject[] = [];
  const multi = allBarViews(score).length > 1;
  for (const bar of barViews(score)) {
    const where = `bar${bar.number}`;
    const barFlags = scoreBarReview(score, bar);
    if (barFlags.flagged) {
      found.push({ address: where, kind: 'bar', id: bar.id, text: null, reasons: barFlags.reasons });
    }
    const at = (onset: number): string => `${where}.beat${beatOfOnset(onset, time)}`;
    // With several staves or voices a bare beat is ambiguous (ADR-0041), so a note says which it is on.
    const own = (onset: number): string => (multi ? `s1.v1.${at(onset)}` : at(onset));
    for (const item of bar.items) {
      if (!item.review.flagged) continue;
      found.push({ address: own(item.onset), kind: item.kind, id: item.id, text: null, reasons: item.review.reasons });
    }
    for (const chord of bar.chords) {
      if (!chord.review.flagged) continue;
      found.push({ address: at(chord.onset), kind: 'chord', id: chord.id, text: chord.text, reasons: chord.review.reasons });
    }
    for (const note of bar.annotations) {
      if (!note.review.flagged) continue;
      found.push({ address: at(note.onset), kind: 'annotation', id: note.id, text: note.text, reasons: note.review.reasons });
    }
  }
  // Items of every other staff and voice, with the qualified address a verb needs to reach them.
  allBarViews(score).slice(1).forEach(({ select: pick }) => {
    const staffNumber = score.parts.flatMap((part) => part.staves).findIndex((staff) => staff.id === pick.staff) + 1;
    for (const bar of barViews(score, pick)) {
      for (const item of bar.items) {
        if (!item.review.flagged) continue;
        const address = `s${staffNumber}.v${pick.voice}.bar${bar.number}.beat${beatOfOnset(item.onset, time)}`;
        found.push({ address, kind: item.kind, id: item.id, text: null, reasons: item.review.reasons });
      }
    }
  });
  return found;
}
