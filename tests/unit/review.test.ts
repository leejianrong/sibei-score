import { invalidBarChart, nastyChart } from '@sibei/fixtures';
import { makeBar, makeScore, NEEDS_REVIEW, projectScore, reviewSummary } from '@sibei/model';
import type { Score } from '@sibei/model';
import { describe, expect, it } from 'vitest';

/**
 * The review summary (V4b): one place that says what "needs review" means, because from now on
 * two surfaces say it.
 *
 * The engraver draws **no indication of a flagged bar** — an under-filled bar and a correct one
 * are the same ink — so review state lives in the chrome or it is invisible. V4b's score rail is
 * that chrome, and the risk with a second surface stating the same fact is that it states it
 * differently. So the sentence is the model's, and the last block here is the one that matters:
 * the projection's review line is built from this summary rather than beside it.
 */

/**
 * A chart with bars and nothing in them, flagged the way the applier flags them — which is what
 * `sibei new --bars 32` leaves in the store. Metric validity is *derived* (ADR-0013) but the
 * `metrically-invalid` reason is *stored*, written by `apply.ts` on every write, so a fixture
 * assembled by hand has to say so explicitly or it is not the document the API would have made.
 */
function blankChart(bars: number): Score {
  return makeScore({
    id: 'score-blank',
    title: 'Body and Soul',
    bars: Array.from({ length: bars }, (_unused, index) =>
      makeBar({
        id: `bar-${index + 1}`,
        number: index + 1,
        review: { flagged: true, reasons: ['metrically-invalid'] },
      }),
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

  it('keeps the stored flag and the derived metric apart', () => {
    // Worth pinning, because collapsing the two is the easy mistake. `invalidBars` is derived and
    // always computable; `anythingFlagged` reads the `review` a write left behind. This fixture is
    // built by hand and carries no flags, so it is metrically invalid and *unflagged* — which the
    // projection has always treated as "print no review line", and the rail follows.
    const summary = reviewSummary(invalidBarChart());
    expect(summary.invalidBars).not.toEqual([]);
    expect(summary.anythingFlagged).toBe(false);
  });

  it('is singular for one bar, because a rail reads the sentence out loud', () => {
    const score = invalidBarChart();
    const one = { ...score, bars: score.bars.filter((bar) => bar.number !== 3) };
    expect(reviewSummary(one).meterNote).toBe('1 bar does not fill the meter');
  });

  it('flags every bar of a blank chart, which is what KAN-597 is about', () => {
    // A freshly created 32-bar chart holds no notes, so every bar is under the meter and the
    // summary says so about all 32. That is the model's current answer and it is honest; whether
    // it is the *useful* answer is KAN-597's question. Pinned here so that card sees a red test
    // rather than a silent change of meaning — and so the rail's wording follows it for free.
    const summary = reviewSummary(blankChart(32));
    expect(summary.anythingFlagged).toBe(true);
    expect(summary.invalidBars).toHaveLength(32);
    expect(summary.meterNote).toBe('32 bars do not fill the meter');
  });
});

describe('the projection and the summary cannot word it differently', () => {
  it('builds the projection review line out of the summary (ADR-0009)', () => {
    const score = blankChart(32);
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
  });
});
