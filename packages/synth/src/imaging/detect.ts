/**
 * Render whole pages with their Stage-1 detection boxes in pixels — the imaging half of the V16
 * detector corpus (ADR-0031). `page-boxes.ts` gives each object's box in layout units; here we render
 * the page and scale the boxes with one factor, exactly as `crops.ts` does for system crops.
 *
 * The scale needs no dpi assumption: the engraved SVG's viewBox is in layout units (`packages/engrave`),
 * so `pxPerUnit = renderedPngWidth / page.width` maps units to pixels in both axes. Lives in the native
 * `@sibei/synth/imaging` half because it loads `sharp`; the box maths it rests on stays pure in
 * `page-boxes.ts`.
 */

import type { PageSpecInput } from '@sibei/layout';
import type { Score } from '@sibei/model';
import sharp from 'sharp';
import type { BoxClass } from '../page-boxes.js';
import { extractPageBoxes } from '../page-boxes.js';
import type { RenderStyleOptions } from './rasterize.js';
import { renderScoreToPng } from './rasterize.js';

export interface DetectPageOptions extends RenderStyleOptions {
  /** Render scale (default 2, matching the corpus). */
  zoom?: number;
  pageSpec?: PageSpecInput;
  background?: string;
}

/** One detection object in the rendered page's pixel grid. */
export interface PxBox {
  cls: BoxClass;
  clsId: number;
  system: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectPage {
  page: number;
  /** The rendered page, a PNG. */
  png: Buffer;
  widthPx: number;
  heightPx: number;
  boxes: PxBox[];
}

/** Clamp a units-derived box to a pixel region guaranteed to lie inside the image. */
function clampPx(x: number, y: number, w: number, h: number, imgW: number, imgH: number): { x: number; y: number; width: number; height: number } {
  const l = Math.max(0, Math.min(Math.round(x), imgW));
  const t = Math.max(0, Math.min(Math.round(y), imgH));
  const width = Math.max(0, Math.min(Math.round(w), imgW - l));
  const height = Math.max(0, Math.min(Math.round(h), imgH - t));
  return { x: l, y: t, width, height };
}

function renderPages(score: Score, options: DetectPageOptions): Buffer[] {
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

/** Render one entry per page: the rendered PNG plus every Stage-1 box scaled to its pixels. */
export async function renderDetectPages(score: Score, options: DetectPageOptions = {}): Promise<DetectPage[]> {
  const pageSpec = options.pageSpec ?? {};
  const pages = renderPages(score, options);
  const unitPages = extractPageBoxes(score, { pageSpec });
  const dims = await pageDims(pages);

  const out: DetectPage[] = [];
  for (const unitPage of unitPages) {
    const dim = dims[unitPage.page]!;
    const pxPerUnit = dim.width / unitPage.width;
    const boxes: PxBox[] = [];
    for (const obj of unitPage.objects) {
      const px = clampPx(obj.box.x * pxPerUnit, obj.box.y * pxPerUnit, obj.box.width * pxPerUnit, obj.box.height * pxPerUnit, dim.width, dim.height);
      if (px.width > 0 && px.height > 0) {
        boxes.push({ cls: obj.cls, clsId: obj.clsId, system: obj.system, ...px });
      }
    }
    out.push({ page: unitPage.page, png: pages[unitPage.page]!, widthPx: dim.width, heightPx: dim.height, boxes });
  }
  return out;
}

const CLASS_COLORS: Record<BoxClass, string> = {
  staff: '#2f6fe0',
  barline: '#e0533a',
  chordBand: '#12a150',
  title: '#a12fd0',
};

/**
 * Draw each page's boxes onto it — a proof image, so a human (and an agent reading the PNG) can
 * confirm the detector's ground truth lands on real ink before training on it. A verification aid,
 * not part of the corpus.
 */
export async function renderPageBoxOverlay(score: Score, options: DetectPageOptions = {}): Promise<Buffer[]> {
  const detected = await renderDetectPages(score, options);
  return Promise.all(
    detected.map(async (page) => {
      const rects = page.boxes
        .map((b) => {
          const color = CLASS_COLORS[b.cls];
          return (
            `<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" fill="none" stroke="${color}" stroke-width="2"/>` +
            `<text x="${b.x + 2}" y="${Math.max(b.y - 3, 10)}" font-family="sans-serif" font-size="12" fill="${color}">${b.cls}</text>`
          );
        })
        .join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${page.widthPx}" height="${page.heightPx}">${rects}</svg>`;
      return sharp(page.png).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
    }),
  );
}
