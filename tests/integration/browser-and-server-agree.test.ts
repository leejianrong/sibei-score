import { MUSIC_FONT_NAMES } from '@sibei/engrave';
import { everyGlyphChart, invalidBarChart, longFormChart, nastyChart, untitledChart } from '@sibei/fixtures';
import { PAPER_SIZES } from '@sibei/layout';
import type { Paper } from '@sibei/layout';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { renderScorePages } from '@sibei/ui';
import { describe, expect, it } from 'vitest';

/**
 * **The browser and the server produce identical layout output for the same score** (SLICES.md's
 * V4 test plan, ADR-0014, ADR-0015).
 *
 * That sentence is vague until something makes it precise, and this is what makes it precise:
 * the two render paths are asserted **byte-identical**, not merely similar, for every fixture in
 * the corpus, in both faces and on both papers.
 *
 * Why there are two paths at all. `renderScoreToSvg` in `@sibei/pdf` is pure — it calls `layout()`
 * then `engravePage()` and nothing else — but the package's only export entry re-exports `pdf.ts`,
 * which imports pdfkit, so a browser importing it drags pdfkit and `Buffer` into the bundle to
 * reach a function that touches neither. The UI therefore composes the same two calls itself
 * (`packages/ui/src/lib/render.ts`), which is six lines.
 *
 * Two copies of six lines is a drift risk, and this test is the whole answer to it. If it ever
 * goes red, screen and print have parted company and one of them is lying about what comes out of
 * the printer — which is the exact failure ADR-0015 exists to prevent.
 *
 * It compares **strings**, so it also fails on a whitespace or attribute-order change that
 * looks identical rendered. That is the point: identity is cheap to keep and expensive to
 * recover.
 */

const FIXTURES: Record<string, () => Score> = {
  'nasty-chart': nastyChart,
  'every-glyph': everyGlyphChart,
  'invalid-bars': invalidBarChart,
  'long-form': longFormChart,
  untitled: untitledChart,
};

/** Derived from the packages that own them, so a face or a paper added later is covered here. */
const PAPERS = Object.keys(PAPER_SIZES) as Paper[];

describe('the browser and the server render the same bytes', () => {
  it('covers the whole fixture corpus, including the one that paginates', () => {
    // Guards the guard: an empty matrix would make every assertion below a tautology, and
    // long-form is the only fixture with a second page for the two paths to disagree about.
    expect(Object.keys(FIXTURES).length).toBeGreaterThan(1);
    expect(renderScoreToSvg(longFormChart()).length).toBeGreaterThan(1);
    expect(PAPERS.length).toBeGreaterThan(1);
    expect(MUSIC_FONT_NAMES.length).toBeGreaterThan(1);
  });

  for (const [name, fixture] of Object.entries(FIXTURES)) {
    for (const paper of PAPERS) {
      for (const font of MUSIC_FONT_NAMES) {
        it(`agrees on ${name}, ${paper}, ${font}`, () => {
          const score = fixture();
          const server = renderScoreToSvg(score, { paper }, { font });
          const browser = renderScorePages(score, { paper }, { font });

          // Page count first: a mismatch here is a pagination difference, and comparing page 1
          // of a two-page render against page 1 of a three-page one would hide it.
          expect(browser.map((page) => page.index)).toEqual(server.map((page) => page.index));

          for (const [index, expected] of server.entries()) {
            const actual = browser[index];
            expect(actual?.svg, `${name} page ${index + 1} (${paper}, ${font})`).toBe(expected.svg);
            expect(actual?.widthPt).toBe(expected.widthPt);
            expect(actual?.heightPt).toBe(expected.heightPt);
          }
        });
      }
    }
  }
});
