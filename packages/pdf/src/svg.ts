import type { MusicFontName } from '@sibei/engrave';
import { engravePage } from '@sibei/engrave';
import type { LayoutResult, PageSpecInput } from '@sibei/layout';
import { layout } from '@sibei/layout';
import type { Score } from '@sibei/model';

/**
 * The server side of "screen and print share one layout path" (ADR-0014). The same
 * `layout` package and the same engraver the browser uses.
 *
 * **There is no DOM here any more.** The VexFlow adapter built its output with the global
 * `document`, so this module used to install jsdom and leave it installed for the life of
 * the process. `@sibei/engrave` emits markup, so a page render is now a pure function
 * from a `LayoutResult` to a string — which is one fewer dependency, one fewer global,
 * and one fewer way for a server render to differ from a browser one (ADR-0030).
 */

export interface RenderOptions {
  /** Which face to engrave in: the engraved `normal`, or the handwritten `jazz`. */
  font: MusicFontName;
}

export interface RenderedPage {
  index: number;
  svg: string;
  widthPt: number;
  heightPt: number;
}

export function renderLayoutToSvg(
  result: LayoutResult,
  options: Partial<RenderOptions> = {},
): RenderedPage[] {
  return result.pages.map((page) => ({
    index: page.index,
    svg: engravePage(result, page.index, options).svg,
    widthPt: page.widthPt,
    heightPt: page.heightPt,
  }));
}

export function renderScoreToSvg(
  score: Score,
  pageSpec: PageSpecInput = {},
  options: Partial<RenderOptions> = {},
): RenderedPage[] {
  return renderLayoutToSvg(layout(score, pageSpec), options);
}
