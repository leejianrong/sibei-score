/**
 * Cut per-system crops from a rendered page — the pixel half of the Stage-2a training pairs (V15a,
 * ADR-0031). `systems.ts` gives each system's box in layout units; here we render the page, turn the
 * box into pixels with one scale, and extract the strip.
 *
 * The scale needs no dpi assumption: the engraved SVG's viewBox is in layout units (packages/engrave),
 * so `pxPerUnit = renderedPngWidth / page.width` maps units to pixels exactly, in both axes (the
 * render preserves aspect). This lives in the native `@sibei/synth/imaging` half because it loads
 * `sharp`; the label maths it rests on stays pure in `systems.ts`.
 */

import type { MusicFontName } from '@sibei/engrave';
import type { PageSpecInput } from '@sibei/layout';
import { layout } from '@sibei/layout';
import type { Score } from '@sibei/model';
import sharp from 'sharp';
import type { ItemToken } from '../labels.js';
import { extractSystemLabels } from '../systems.js';
import type { Vocabulary } from '../vocab.js';
import { renderScoreToPng } from './rasterize.js';

export interface SystemCropOptions {
  /** Render scale (default 2, matching the corpus). */
  zoom?: number;
  font?: MusicFontName;
  pageSpec?: PageSpecInput;
  background?: string;
  /** When given, each crop also carries the vocabulary `tokenIds`. */
  vocab?: Vocabulary;
  /** Pixels of slack added around each system box, so a tall note is never shaved (default 0). */
  pad?: number;
}

export interface SystemCrop {
  index: number;
  page: number;
  /** The cropped staff strip, a PNG. */
  png: Buffer;
  widthPx: number;
  heightPx: number;
  /** Notes and rests in reading order — the CTC target for this crop. */
  tokens: ItemToken[];
  tokenIds?: number[];
}

interface PxBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Round a units-derived box to a pixel region that is guaranteed to lie inside the image. */
function clampBox(left: number, top: number, width: number, height: number, imgW: number, imgH: number): PxBox {
  const l = Math.max(0, Math.min(Math.round(left), imgW - 1));
  const t = Math.max(0, Math.min(Math.round(top), imgH - 1));
  const w = Math.max(1, Math.min(Math.round(width), imgW - l));
  const h = Math.max(1, Math.min(Math.round(height), imgH - t));
  return { left: l, top: t, width: w, height: h };
}

async function pageDims(pages: Buffer[]): Promise<{ width: number; height: number }[]> {
  return Promise.all(
    pages.map(async (buf) => {
      const meta = await sharp(buf).metadata();
      return { width: meta.width ?? 0, height: meta.height ?? 0 };
    }),
  );
}

function renderPages(score: Score, options: SystemCropOptions): Buffer[] {
  return renderScoreToPng(score, {
    ...(options.zoom === undefined ? {} : { zoom: options.zoom }),
    ...(options.font === undefined ? {} : { font: options.font }),
    pageSpec: options.pageSpec ?? {},
    ...(options.background === undefined ? {} : { background: options.background }),
  });
}

/** Render one crop per staff system, pages then systems in order, each with its token sequence. */
export async function renderSystemCrops(score: Score, options: SystemCropOptions = {}): Promise<SystemCrop[]> {
  const pageSpec = options.pageSpec ?? {};
  const pages = renderPages(score, options);
  const result = layout(score, pageSpec);
  const labels = extractSystemLabels(score, { pageSpec, ...(options.vocab ? { vocab: options.vocab } : {}) });
  const dims = await pageDims(pages);
  const pad = options.pad ?? 0;

  const crops: SystemCrop[] = [];
  for (const label of labels) {
    const dim = dims[label.box.page]!;
    const pxPerUnit = dim.width / result.pages[label.box.page]!.width;
    const box = clampBox(
      label.box.x * pxPerUnit - pad,
      label.box.y * pxPerUnit - pad,
      label.box.width * pxPerUnit + pad * 2,
      label.box.height * pxPerUnit + pad * 2,
      dim.width,
      dim.height,
    );
    const png = await sharp(pages[label.box.page]!).extract(box).png().toBuffer();
    crops.push({
      index: label.index,
      page: label.box.page,
      png,
      widthPx: box.width,
      heightPx: box.height,
      tokens: label.tokens,
      ...(label.tokenIds ? { tokenIds: label.tokenIds } : {}),
    });
  }
  return crops;
}

/**
 * Draw each system's crop box onto its page — a proof image, so a human (and an agent reading the
 * PNG) can confirm the boxes land on the staves before trusting the crops. Not part of the training
 * output; a verification aid.
 */
export async function renderSystemBoxOverlay(score: Score, options: SystemCropOptions = {}): Promise<Buffer[]> {
  const pageSpec = options.pageSpec ?? {};
  const pages = renderPages(score, options);
  const result = layout(score, pageSpec);
  const labels = extractSystemLabels(score, { pageSpec });
  const dims = await pageDims(pages);

  return Promise.all(
    pages.map(async (buf, pageIndex) => {
      const dim = dims[pageIndex]!;
      const pxPerUnit = dim.width / result.pages[pageIndex]!.width;
      const rects = labels
        .filter((label) => label.box.page === pageIndex)
        .map((label) => {
          const x = label.box.x * pxPerUnit;
          const y = label.box.y * pxPerUnit;
          const w = label.box.width * pxPerUnit;
          const h = label.box.height * pxPerUnit;
          return (
            `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="rgba(224,83,58,0.06)" stroke="#e0533a" stroke-width="3"/>` +
            `<text x="${x + 8}" y="${y + 26}" font-family="sans-serif" font-size="20" fill="#e0533a">sys ${label.index} · ${label.tokens.length} tokens</text>`
          );
        })
        .join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${dim.width}" height="${dim.height}">${rects}</svg>`;
      return sharp(buf).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
    }),
  );
}
