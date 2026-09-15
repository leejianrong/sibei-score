import { reviewChart } from '@sibei/fixtures';
import { barReview, orderedItems, projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';
import { describe, expect, it } from 'vitest';

/**
 * **The two surfaces flag the same objects** (SLICES.md V14 step 3 — verify).
 *
 * The `!` review markers ship in `sbscore show` (V13) and the browser rail consumes the same
 * `reviewSummary`/`barReview` derivation — but nothing pinned that the *set* of flags one surface
 * shows equals the set the other prints for one score. An under-filled bar and a correct one are the
 * same ink (the engraver draws no flag), so review state lives entirely in the chrome; if the CLI and
 * the browser disagreed about *which* objects are flagged, one of them would be lying and no snapshot
 * would catch it. This is the ADR-0002 "two surfaces cannot word it differently" guarantee applied to
 * the flag set rather than to the review *sentence* (which `tests/unit/review.test.ts` already pins).
 *
 * ## What "the browser flag set" is, and why it is the model's derivation
 *
 * The browser holds no store and no second review path: its rail reads `reviewSummary`, and the
 * flagged notes/chords it shades on the sheet are the ones `layout` carries `review.flagged` through
 * for (KAN-611). Both come from `@sibei/model` — `barReview(bar, time).flagged` for a bar, the stored
 * `review.flagged` for an item or chord. So the browser's flag set *is* that model derivation, and
 * this test computes it directly rather than booting Chromium to read shading back out of pixels.
 *
 * ## Why bars, notes and chords — and not annotations
 *
 * The projection is lossy on purpose (ADR-0009): it drops annotations entirely. A flagged annotation
 * therefore shows in the browser but never as a projection `!` — a *legitimate* divergence, not a
 * bug, so the parity is over the object kinds the projection represents. The second test pins that
 * exclusion so it can never silently widen into "the projection quietly stopped flagging something".
 */

/** The flagged-object set the browser derives from the model, over bars/notes/chords. */
function browserFlagSet(score: Score): Set<string> {
  const flags = new Set<string>();
  for (const bar of score.bars) {
    if (barReview(bar, score.meta.time).flagged) flags.add(`bar${bar.number}`);
    orderedItems(bar).forEach((item, index) => {
      if (item.review.flagged) flags.add(`bar${bar.number}.n${index + 1}`);
    });
    for (const chord of bar.chords) {
      if (chord.review.flagged) flags.add(`bar${bar.number}.chord:${chord.text}`);
    }
  }
  return flags;
}

/**
 * The flagged-object set the CLI prints, read back out of the `projectScore` text alone — no peeking
 * at the model, so the two sets are derived independently and their equality means something. `!`
 * never occurs inside a pitch, a duration or a chord symbol, so its presence in a token is
 * unambiguous (ADR-0009). The fixtures here are ≤ 4 bars, i.e. one four-bar row, so a chord cell's
 * column index is its bar number.
 */
function projectionFlagSet(score: Score): Set<string> {
  const flags = new Set<string>();
  for (const line of projectScore(score).split('\n')) {
    const melody = /^\s*bar(\d+)(!?)\s+(.*)$/.exec(line);
    if (melody !== null) {
      const barNumber = melody[1];
      if (melody[2] === '!') flags.add(`bar${barNumber}`);
      // Split the melody body before each `nK`; `n` never occurs inside a note body, and a lone `!`
      // in a chunk is that item's flag (` !` or ` !NN`).
      for (const chunk of (melody[3] ?? '').split(/(?=n\d+\s)/)) {
        const item = /^n(\d+)/.exec(chunk.trim());
        if (item !== null && chunk.includes('!')) flags.add(`bar${barNumber}.n${item[1]}`);
      }
      continue;
    }

    const chordRow = /^\s*(\d+) \|/.exec(line);
    if (chordRow !== null) {
      // Cells are bar-ordered from the row's first bar; a ≤ 4-bar score starts at bar 1, so cell
      // index (1-based, after the gutter) is the bar number.
      const cells = line.split('|');
      for (let cell = 1; cell < cells.length - 1; cell += 1) {
        for (const token of (cells[cell] ?? '').trim().split(/\s+/).filter(Boolean)) {
          if (token.includes('!')) flags.add(`bar${cell}.chord:${token.split('!')[0]}`);
        }
      }
    }
  }
  return flags;
}

const sorted = (set: Set<string>): string[] => [...set].sort();

describe('the CLI and the browser flag the same objects (V14)', () => {
  it('agrees on every bar, note and chord of the review fixture', () => {
    // `reviewChart` is the canonical review corpus: a low-confidence note and chord clear of any bar
    // wash (bar 1), a note flagged inside an under-filled bar so the wash and the object stripe
    // overlap (bar 2), and a flagged annotation (bar 3). It carries all three flag kinds plus an
    // invalid bar — exactly the "flagged objects + an invalid bar" the V14 step-3 check asks for.
    const score = reviewChart();
    const browser = browserFlagSet(score);
    const cli = projectionFlagSet(score);

    // Guard the guard: an empty set would make the equality a tautology. The fixture must contribute
    // a metric bar flag, a note flag and a chord flag, so the parse is exercised on all three.
    expect(browser.size).toBeGreaterThanOrEqual(3);
    expect(sorted(browser)).toContain('bar2'); // the under-filled bar
    expect([...browser].some((flag) => flag.startsWith('bar1.n'))).toBe(true); // a note
    expect([...browser].some((flag) => flag.includes('.chord:'))).toBe(true); // a chord

    expect(sorted(cli)).toEqual(sorted(browser));
  });

  it('excludes annotations, the one flag the projection is lossy about (ADR-0009)', () => {
    // Bar 3's annotation is flagged and the browser draws it flagged, but the projection drops
    // annotations, so it is browser-only by design. This is why the parity above is scoped to
    // bars/notes/chords — and pinning it here stops that scope from being read as an accident.
    const score = reviewChart();
    const flaggedAnnotation = score.bars
      .flatMap((bar) => bar.annotations)
      .find((annotation) => annotation.review.flagged);
    expect(flaggedAnnotation, 'the review fixture carries a flagged annotation').toBeDefined();

    // The browser derivation would surface it; the projection does not represent it at all.
    expect(flaggedAnnotation!.review.flagged).toBe(true);
    expect(projectScore(score)).not.toContain(flaggedAnnotation!.text);
  });
});
