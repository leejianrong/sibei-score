import { engravePage } from '@sibei/engrave';
import type { MusicFontName } from '@sibei/engrave';
import { layout } from '@sibei/layout';
import type { LayoutPage, PageSpecInput } from '@sibei/layout';
import type { Score } from '@sibei/model';

/**
 * The browser side of "screen and print share one layout path" (ADR-0014, ADR-0015).
 *
 * **Why this is six lines here rather than an import.** `@sibei/pdf` already has exactly this
 * function — `renderScoreToSvg`, and it is pure — but the package's only export entry re-exports
 * `pdf.ts`, which imports pdfkit. Importing it from the browser would drag pdfkit and `Buffer`
 * into the bundle to reach a function that touches neither. `@sibei/engrave` emits SVG **markup**
 * rather than DOM nodes (ADR-0030), so composing the two calls here costs nothing and keeps the
 * bundle to what the page needs.
 *
 * **What stops the two copies drifting is a test, not a promise.**
 * `tests/integration/browser-and-server-agree.test.ts` renders every fixture through both and
 * asserts the SVG comes out **byte-identical**, in both faces and on both papers. That is
 * SLICES.md's "the browser and the server produce identical layout output for the same score",
 * made precise: if it ever goes red, screen and print have drifted and one of them is lying about
 * what comes out of the printer.
 *
 * Nothing here decides anything about the page. Layout owns everything above the bar and the
 * engraver everything inside it; this function picks neither (ADR-0014).
 */

export interface RenderOptions {
  /** Which face to engrave in: the engraved `normal`, or the handwritten `jazz` (ADR-0030). */
  font: MusicFontName;
}

export interface RenderedPage {
  index: number;
  svg: string;
  widthPt: number;
  heightPt: number;
  /**
   * This page's own geometry, verbatim from `layout()`. Hit-testing (V4c) reuses it rather than
   * running `layout()` a second time — the note it finds under a click is positioned from the
   * exact object the SVG above was drawn from, not a recomputation that could drift from it.
   */
  layout: LayoutPage;
}

export function renderScorePages(
  score: Score,
  pageSpec: PageSpecInput = {},
  options: Partial<RenderOptions> = {},
  /**
   * Bar numbers whose "does not fill the meter" wash is left off (SIB2-280). Note input previews the next note in a
   * copy of the score, so the bar being typed into is under-filled by construction and would flash rose with every
   * key. The bar is still stored and judged as written (ADR-0013); only this draw skips the wash, and nothing
   * changes when the set is empty, so the byte-identical guarantee with the server holds for every other render.
   */
  quietBars: ReadonlySet<number> = new Set(),
): RenderedPage[] {
  const result = layout(score, pageSpec);
  if (quietBars.size > 0) {
    for (const page of result.pages) {
      for (const system of page.systems) {
        for (const bar of system.bars) {
          if (quietBars.has(bar.barNumber) && !bar.metrics.valid) bar.metrics = { ...bar.metrics, valid: true };
        }
      }
    }
  }
  return result.pages.map((page) => ({
    index: page.index,
    svg: engravePage(result, page.index, options).svg,
    widthPt: page.widthPt,
    heightPt: page.heightPt,
    layout: page,
  }));
}
