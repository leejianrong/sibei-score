import { invalidBarChart, nastyChart } from '@sibei/fixtures';
import {
  barReview,
  dur,
  makeAnnotation,
  makeBar,
  makeNote,
  makeScore,
  makeSection,
  NEEDS_REVIEW,
  NO_SECTIONS_ADVISORY,
  projectScore,
  reviewSummary,
} from '@sibei/model';
import type { Score } from '@sibei/model';
import { describe, expect, it } from 'vitest';

/**
 * The review summary: one place that says what "needs review" means, because more than one surface
 * says it.
 *
 * The engraver draws **no indication of a flagged bar** — an under-filled bar and a correct one
 * are the same ink — so review state lives in the chrome or it is invisible. V4b's score rail is
 * that chrome, and the risk with a second surface stating the same fact is that it states it
 * differently. So the sentence is the model's, and the last block here is the one that matters:
 * the projection's review line is built from this summary rather than beside it.
 *
 * KAN-597 settled the two questions this file now pins. `metrically-invalid` is **derived by every
 * reader** rather than read back out of the document, and an **empty bar is not a review case**.
 */

/**
 * A chart with bars and nothing in them: what `sbscore new --bars 32` leaves in the store.
 *
 * It is built with plain `makeBar`, with no review flag anywhere, and that is now the *whole* of
 * the fixture — before KAN-597 it had to stamp `metrically-invalid` on every bar by hand to
 * resemble the document the applier would have written. It no longer does, because the applier no
 * longer writes one for an empty bar and no reader consults the stored copy anyway.
 */
function blankChart(bars: number): Score {
  return makeScore({
    id: 'score-blank',
    title: 'Body and Soul',
    bars: Array.from({ length: bars }, (_unused, index) =>
      makeBar({ id: `bar-${index + 1}`, number: index + 1 }),
    ),
  });
}

describe('reviewSummary', () => {
  it('says nothing is flagged when nothing is', () => {
    const summary = reviewSummary(nastyChart());
    expect(summary.anythingFlagged).toBe(false);
    expect(summary.invalidBars).toEqual([]);
    expect(summary.meterNote).toBeNull();
  });

  it('names the bars that do not fill the meter, in bar order (ADR-0013)', () => {
    // The fixture's bar 1 is short and bar 3 is long; bar 2 sums exactly.
    const summary = reviewSummary(invalidBarChart());
    expect(summary.invalidBars).toEqual([1, 3]);
    expect(summary.meterNote).toBe('2 bars do not fill the meter');
  });

  it('has one source: a hand-built invalid chart reports flagged, not "nothing flagged" (KAN-597)', () => {
    // The defect this card was reopened for. `anythingFlagged` used to read the *stored*
    // `bar.review.flagged` while `invalidBars` derived the same fact from the bar's contents, so
    // the fixture whose entire purpose is invalid bars answered `false` — and the score rail
    // printed "Nothing flagged." over two invalid bars. It looked fine only because the applier
    // stamps the flag on write, so every API-authored chart happened to be right: correct exactly
    // where anyone looked, wrong where nobody did.
    const summary = reviewSummary(invalidBarChart());
    expect(summary.invalidBars).toEqual([1, 3]);
    expect(summary.anythingFlagged).toBe(true);
  });

  it('still reports a flag nothing can derive, which is why review is not purely derived', () => {
    // `low-confidence`, `unparsed-chord` and `unrecognised-text` come out of the import pipeline
    // and are not recomputable from the document — a stored flag is the only possible source for
    // them (ADR-0011, ADR-0012). So "one source" is one source *per question*, not one mechanism:
    // metric validity is always derived, everything else is always stored.
    const score = makeScore({
      id: 'score-low-confidence',
      bars: [
        makeBar({
          id: 'bar-1',
          number: 1,
          items: [
            makeNote({
              id: 'note-1',
              onset: 0,
              duration: dur(1),
              pitch: 'C5',
              review: { flagged: true, reasons: ['low-confidence'] },
            }),
          ],
        }),
      ],
    });

    const summary = reviewSummary(score);
    expect(summary.invalidBars).toEqual([]);
    expect(summary.meterNote).toBeNull();
    expect(summary.anythingFlagged).toBe(true);
  });

  it('flags on a reviewed annotation, though it is not a bar, an item or a chord (KAN-611)', () => {
    // Same shape as KAN-597, one object smaller: `packages/layout` carries an annotation's
    // `review.flagged` through to the page (drawn as flagged), so a summary that misses
    // annotations can claim nothing needs review while the page shows otherwise.
    const score = makeScore({
      id: 'score-flagged-annotation',
      bars: [
        makeBar({
          id: 'bar-1',
          number: 1,
          annotations: [
            makeAnnotation({
              id: 'annotation-1',
              onset: 0,
              text: 'Solo',
              review: { flagged: true, reasons: ['unrecognised-text'] },
            }),
          ],
        }),
      ],
    });

    const summary = reviewSummary(score);
    expect(summary.invalidBars).toEqual([]);
    expect(summary.meterNote).toBeNull();
    expect(summary.anythingFlagged).toBe(true);
  });

  it('is singular for one bar, because a rail reads the sentence out loud', () => {
    const score = invalidBarChart();
    const one = { ...score, bars: score.bars.filter((bar) => bar.number !== 3) };
    expect(reviewSummary(one).meterNote).toBe('1 bar does not fill the meter');
  });

  it('has nothing to say about a blank chart, because an empty bar is not a review case (KAN-597)', () => {
    // A blank 32-bar chart is the normal starting state of every chart anyone creates, and it used
    // to report "32 bars do not fill the meter" — a review signal firing on 100% of a new
    // document, which is a signal that has stopped signalling. An empty bar is not a rhythm the
    // system disagrees with; it is the absence of one, and ADR-0013's reasoning is entirely about
    // the former.
    const summary = reviewSummary(blankChart(32));
    expect(summary.anythingFlagged).toBe(false);
    expect(summary.invalidBars).toEqual([]);
    expect(summary.meterNote).toBeNull();
  });

  it('starts reporting the moment a bar holds a rhythm that is short', () => {
    // The other half of the same decision: "empty" must not become a way to hide a real problem.
    // One quarter in a 4/4 bar is a rhythm, and a wrong one.
    const score = blankChart(8);
    const started: Score = {
      ...score,
      bars: score.bars.map((bar, index) =>
        index === 0
          ? { ...bar, items: [makeNote({ id: 'note-1', onset: 0, duration: dur(4), pitch: 'C5' })] }
          : bar,
      ),
    };
    expect(reviewSummary(started).invalidBars).toEqual([1]);
    expect(reviewSummary(started).meterNote).toBe('1 bar does not fill the meter');
  });
});

describe('barReview is the one place a bar’s review state comes from', () => {
  it('derives metrically-invalid rather than reading the stored copy', () => {
    const short = makeBar({
      id: 'bar-1',
      number: 1,
      items: [makeNote({ id: 'note-1', onset: 0, duration: dur(4), pitch: 'C5' })],
    });
    expect(barReview(short, { beats: 4, beatValue: 4 })).toEqual({
      flagged: true,
      reasons: ['metrically-invalid'],
    });
  });

  it('drops a stale stored metrically-invalid from a bar that now fills the meter', () => {
    // The staleness that made this a two-source bug, stated directly: the document says one thing
    // and the bar's contents say another, and the contents win.
    const stale = makeBar({
      id: 'bar-1',
      number: 1,
      items: [makeNote({ id: 'note-1', onset: 0, duration: dur(1), pitch: 'C5' })],
      review: { flagged: true, reasons: ['metrically-invalid'] },
    });
    expect(barReview(stale, { beats: 4, beatValue: 4 })).toEqual({ flagged: false, reasons: [] });
  });

  it('leaves reasons it cannot derive alone', () => {
    const imported = makeBar({
      id: 'bar-1',
      number: 1,
      items: [makeNote({ id: 'note-1', onset: 0, duration: dur(4), pitch: 'C5' })],
      review: { flagged: true, reasons: ['low-confidence'] },
    });
    expect(barReview(imported, { beats: 4, beatValue: 4 }).reasons).toEqual([
      'low-confidence',
      'metrically-invalid',
    ]);
  });
});

describe('the no-sections advisory has one predicate both surfaces read (V14, ADR-0015)', () => {
  // Sections drive line-breaking: a section boundary forces a line break even mid-grid, so a chart
  // *with* sections lays out at the form and one *without* lays out on a plain four-bar grid. That
  // the grid actually breaks at a section is proved by tests/unit/grid.test.ts ("breaks the line
  // mid-grid, so an 11-bar section lays out 4 / 4 / 3") and tests/cli/section.test.ts (a section on
  // bar 3 turns 4/4 into 2/4/2). Here we only pin the predicate the advisory rides.

  it('reports hasSections false for a fresh, section-less chart', () => {
    // A blank `sbscore new` chart and a fresh import (ADR-0021) both start with no sections.
    expect(reviewSummary(blankChart(8)).hasSections).toBe(false);
  });

  it('reports hasSections true the moment a section exists', () => {
    const withSection = makeScore({
      id: 'score-with-section',
      bars: [makeBar({ id: 'bar-1', number: 1 })],
      sections: [makeSection({ id: 'section-1', startBar: 1, letter: 'A', name: 'A' })],
    });
    expect(reviewSummary(withSection).hasSections).toBe(true);

    // And a fixture that carries real sections agrees, so the predicate is not just true of a
    // hand-built stub.
    expect(reviewSummary(nastyChart()).hasSections).toBe(true);
  });

  it('is an advisory, not a review flag: it fires even when nothing needs review (ADR-0013/0019)', () => {
    // A clean blank chart reports nothing flagged (KAN-597), yet still carries the layout advisory —
    // the two are independent facts, which is why `hasSections` sits beside `anythingFlagged` rather
    // than inside it. Nothing is refused or repaired; the layout is simply not yet broken at the form.
    const blank = blankChart(8);
    expect(reviewSummary(blank).anythingFlagged).toBe(false);
    expect(projectScore(blank)).not.toContain(NEEDS_REVIEW);
    expect(projectScore(blank)).toContain(NO_SECTIONS_ADVISORY);
  });

  it('projects the advisory only for a section-less chart, so both surfaces read the same string', () => {
    // The projection prints the model's string verbatim (V14), the same one the score rail shows —
    // the review-line rule (ADR-0002) extended to the advisory: two surfaces cannot word it two ways.
    expect(projectScore(blankChart(8))).toContain(NO_SECTIONS_ADVISORY);
    expect(projectScore(nastyChart())).not.toContain(NO_SECTIONS_ADVISORY);
  });
});

describe('the projection and the summary cannot word it differently', () => {
  it('builds the projection review line out of the summary (ADR-0009)', () => {
    const score = invalidBarChart();
    const summary = reviewSummary(score);
    const line = projectScore(score)
      .split('\n')
      .find((candidate) => candidate.includes(NEEDS_REVIEW));

    expect(line).toBeDefined();
    expect(line).toBe(`  ! = ${NEEDS_REVIEW} · ${summary.meterNote}`);
  });

  it('prints no review line at all when the summary has nothing to report', () => {
    expect(reviewSummary(nastyChart()).anythingFlagged).toBe(false);
    expect(projectScore(nastyChart())).not.toContain(NEEDS_REVIEW);

    // And a blank chart is now one of those: nothing to report, so nothing printed.
    expect(projectScore(blankChart(32))).not.toContain(NEEDS_REVIEW);
  });
});
