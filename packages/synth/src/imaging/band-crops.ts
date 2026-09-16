/**
 * Cut per-system chord-band crops — the pixel half of the Stage-2b training pairs (V17b, ADR-0031).
 *
 * `page-boxes.ts` gives each system's `chordBand` box in layout units (the full-width strip above the
 * staff where chord symbols sit); `chord-labels.ts` gives that system's chord glyph strings in reading
 * order. Here we render the page in the requested style, scale the band box to pixels with the one
 * factor `pxPerUnit = renderedPngWidth / page.width` (no dpi assumption — the engraved SVG's viewBox is
 * in layout units), and extract the strip, pairing it with its labels. Mirrors `crops.ts`, which does
 * the same for whole-system Stage-2a crops.
 *
 * Only systems that carry chords produce a crop (a bandless system has no `chordBand` box). Loads
 * `sharp`, so this lives in the native `@sibei/synth/imaging` half.
 */

import type { ChordStyle, MusicFontName } from '@sibei/engrave';
import type { PageSpecInput } from '@sibei/layout';
import sharp from 'sharp';
import { extractSystemChords } from '../chord-labels.js';
import type { ChordVocabulary } from '../chord-vocab.js';
import { extractPageBoxes } from '../page-boxes.js';
import { renderScoreToPng } from './rasterize.js';
import type { Score } from '@sibei/model';

export interface BandCropOptions {
  /** Render scale (default 2, matching the corpus). */
  zoom?: number;
  font?: MusicFontName;
  /** The chord symbology to render (and label) in. */
  chordStyle?: ChordStyle;
  /** The text font family to render in. */
  textFont?: string;
  pageSpec?: PageSpecInput;
  background?: string;
  /** When given, each crop also carries the CTC `tokenIds` (band-encoded, chords joined by the separator). */
  vocab?: ChordVocabulary;
  /** Pixels of slack added around the band box, so a tall superscript is never shaved (default 2). */
  pad?: number;
}

export interface BandCrop {
  /** The system index across the score (`LayoutSystem.index`). */
  index: number;
  page: number;
  /** The cropped chord-band strip, a PNG. */
  png: Buffer;
  widthPx: number;
  heightPx: number;
  /** The chord glyph strings in reading order — the label for this crop. */
  chords: string[];
  /** The CTC target ids for the band (chords joined by the separator), present only when a vocab was supplied. */
  tokenIds?: number[];
}

interface PxBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clampBox(left: number, top: number, width: number, height: number, imgW: number, imgH: number): PxBox {
  const l = Math.max(0, Math.min(Math.round(left), imgW - 1));
  const t = Math.max(0, Math.min(Math.round(top), imgH - 1));
  const w = Math.max(1, Math.min(Math.round(width), imgW - l));
  const h = Math.max(1, Math.min(Math.round(height), imgH - t));
  return { left: l, top: t, width: w, height: h };
}

function renderPages(score: Score, options: BandCropOptions): Buffer[] {
  return renderScoreToPng(score, {
    ...(options.zoom === undefined ? {} : { zoom: options.zoom }),
    ...(options.font === undefined ? {} : { font: options.font }),
    ...(options.chordStyle === undefined ? {} : { chordStyle: options.chordStyle }),
    ...(options.textFont === undefined ? {} : { textFont: options.textFont }),
    pageSpec: options.pageSpec ?? {},
    ...(options.background === undefined ? {} : { background: options.background }),
  });
}

async function pageDims(pages: Buffer[]): Promise<{ width: number; height: number }[]> {
  return Promise.all(
    pages.map(async (buf) => {
      const meta = await sharp(buf).metadata();
      return { width: meta.width ?? 0, height: meta.height ?? 0 };
    }),
  );
}

/** Render one chord-band crop per chord-carrying system, pages then systems in order, with its labels. */
export async function renderBandCrops(score: Score, options: BandCropOptions = {}): Promise<BandCrop[]> {
  const pageSpec = options.pageSpec ?? {};
  const pages = renderPages(score, options);
  const pageBoxes = extractPageBoxes(score, { pageSpec });
  const chordStyle = options.chordStyle;
  const chords = extractSystemChords(score, {
    pageSpec,
    ...(chordStyle ? { style: chordStyle } : {}),
  });
  const chordsByIndex = new Map(chords.map((c) => [c.index, c]));
  const dims = await pageDims(pages);
  const pad = options.pad ?? 2;

  const crops: BandCrop[] = [];
  for (const page of pageBoxes) {
    const dim = dims[page.page]!;
    const pxPerUnit = dim.width / page.width;
    for (const object of page.objects) {
      if (object.cls !== 'chordBand' || object.system === null) continue;
      const label = chordsByIndex.get(object.system);
      const box = clampBox(
        object.box.x * pxPerUnit - pad,
        object.box.y * pxPerUnit - pad,
        object.box.width * pxPerUnit + pad * 2,
        object.box.height * pxPerUnit + pad * 2,
        dim.width,
        dim.height,
      );
      const png = await sharp(pages[page.page]!).extract(box).png().toBuffer();
      const chordStrings = label?.chords ?? [];
      crops.push({
        index: object.system,
        page: page.page,
        png,
        widthPx: box.width,
        heightPx: box.height,
        chords: chordStrings,
        ...(options.vocab ? { tokenIds: options.vocab.encodeBand(chordStrings) } : {}),
      });
    }
  }
  return crops;
}
