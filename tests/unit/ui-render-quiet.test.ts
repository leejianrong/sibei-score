import { reviewChart } from '@sibei/fixtures';
import { invalidBars } from '@sibei/model';
import { renderScorePages } from '@sibei/ui';
import { describe, expect, it } from 'vitest';

/**
 * SIB2-280: the bar under the note-input ghost is under-filled by construction, so its rose "does not fill the meter"
 * wash is left off for that bar while typing. Nothing else about the draw changes: with no quiet bars the output is the
 * one the server prints, and a genuinely invalid bar elsewhere keeps its wash.
 */
describe('renderScorePages quietBars (SIB2-280)', () => {
  const score = reviewChart();
  const invalid = invalidBars(score).map((bar) => bar.barNumber);
  const washes = (quiet?: ReadonlySet<number>): number =>
    renderScorePages(score, {}, {}, quiet)
      .map((page) => page.svg.split('se-invalidbar').length - 1)
      .reduce((a, b) => a + b, 0);

  it('draws the wash for the invalid bar by default', () => {
    expect(invalid.length).toBeGreaterThan(0);
    expect(washes()).toBe(invalid.length);
  });

  it('omits it for the bar named, and only that bar', () => {
    expect(washes(new Set([invalid[0]!]))).toBe(invalid.length - 1);
    expect(washes(new Set([999]))).toBe(invalid.length);
  });

  it('is byte-identical to the plain render when nothing is quiet', () => {
    expect(renderScorePages(score, {}, {}, new Set()).map((p) => p.svg)).toEqual(renderScorePages(score).map((p) => p.svg));
  });
});
