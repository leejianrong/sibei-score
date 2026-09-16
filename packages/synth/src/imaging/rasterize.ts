/**
 * Score → raster image, the corpus's clean starting point before degradation.
 *
 * The composition — `layout()` then `engravePage()` — is copied from `@sibei/pdf`'s
 * `renderScoreToSvg` rather than imported, because pulling in `@sibei/pdf` would drag pdfkit
 * and `Buffer` juggling in for no reason and blur the one-render-path boundary (ADR-0014): this
 * package renders through the same two packages the browser and the server do, and stops there.
 * The SVG is then rasterised with `@resvg/resvg-js`, exactly as `scripts/proof.ts` does.
 *
 * Uses `Buffer` — a Node API, the ADR-0031 exception this package holds; this is why it lives
 * behind the `@sibei/synth/imaging` subpath and not in the pure barrel.
 */

import { Resvg } from '@resvg/resvg-js';
import type { ChordStyle, EngraveOptions, MusicFontName } from '@sibei/engrave';
import { engravePage } from '@sibei/engrave';
import type { PageSpecInput } from '@sibei/layout';
import { layout } from '@sibei/layout';
import type { Score } from '@sibei/model';

export interface RenderedPage {
  index: number;
  svg: string;
}

/** The subset of `EngraveOptions` a corpus randomises: the music face, chord symbology and text font. */
export interface RenderStyleOptions {
  font?: MusicFontName;
  /** Chord symbology (V17a) — Δ vs `maj`, ø vs a spelled `m7♭5`, and so on. */
  chordStyle?: ChordStyle;
  /** Text font family for the title block and chord symbols (V17a). */
  textFont?: string;
}

/** Build the `Partial<EngraveOptions>` for a style, omitting undefined (exactOptionalPropertyTypes). */
function engraveOptions(style: RenderStyleOptions): Partial<EngraveOptions> {
  return {
    ...(style.font === undefined ? {} : { font: style.font }),
    ...(style.chordStyle === undefined ? {} : { chordStyle: style.chordStyle }),
    ...(style.textFont === undefined ? {} : { textFont: style.textFont }),
  };
}

/** Score → one SVG string per page. Mirrors `@sibei/pdf`'s renderScoreToSvg (ADR-0014). */
export function renderScoreToSvg(
  score: Score,
  pageSpec: PageSpecInput = {},
  options: RenderStyleOptions = {},
): RenderedPage[] {
  const result = layout(score, pageSpec);
  const opts = engraveOptions(options);
  return result.pages.map((page) => ({
    index: page.index,
    svg: engravePage(result, page.index, opts).svg,
  }));
}

export interface RasterizeOptions {
  /** Render scale. 2 gives a ~1600×2200 A4 page — close to a phone photo's resolution. */
  zoom?: number;
  /** Paper background; white for a printed page. */
  background?: string;
}

/** One SVG string → a PNG buffer. */
export function rasterizeSvg(svg: string, options: RasterizeOptions = {}): Buffer {
  const png = new Resvg(svg, {
    background: options.background ?? 'white',
    fitTo: { mode: 'zoom', value: options.zoom ?? 2 },
  })
    .render()
    .asPng();
  return Buffer.from(png);
}

export interface RenderPngOptions extends RasterizeOptions, RenderStyleOptions {
  pageSpec?: PageSpecInput;
}

/** Score → one PNG buffer per page. A lead sheet is usually a single page. */
export function renderScoreToPng(score: Score, options: RenderPngOptions = {}): Buffer[] {
  const pageSpec = options.pageSpec ?? {};
  return renderScoreToSvg(score, pageSpec, options).map((page) => rasterizeSvg(page.svg, options));
}
