/**
 * Page-level bounding-box labels for the Stage-1 layout detector (V16, ADR-0031).
 *
 * Stage 2a (V15a) reads *one system crop*; Stage 1 works on the *whole page* and must find where the
 * systems, barlines, chord band and title block sit before anything can be cropped. This module reads
 * those boxes straight off `layout()` — every one of them is already computed there (the staff sits at
 * `staveY`, each bar carries its `x`/`width`, the chord baseline is `chordBaselineOffset` above the
 * staff, the header is `LayoutText`), so there is **no detection here**: we render a score we already
 * hold and read the ground truth off its own layout, exactly the trick V15a used per system. The
 * imaging half (`@sibei/synth/imaging`) turns these unit boxes into a rendered page + pixel labels;
 * this stays pure so it runs on the fast test layer.
 *
 * Boxes are in **layout units** (one staff space is 10 units, `packages/layout`). The imaging step
 * scales them to pixels with the single factor `pxPerUnit = renderedPngWidth / page.width`, which needs
 * no dpi assumption because the engraved SVG's viewBox is in those same units — identical to `systems.ts`.
 *
 * Derived, not detected: **bars and four-bar phrases are not object classes** (ADR-0031). A barline is
 * a thing on the page (we emit one per drawn divider); a *bar* is the span between two of them, which
 * `assemble.py` reconstructs from the detected barline x's + system breaks, never as its own box.
 *
 * Framework-free, Node-free plain TypeScript.
 */

import type { LayoutText, PageSpecInput } from '@sibei/layout';
import { layout } from '@sibei/layout';
import type { Score } from '@sibei/model';

/** The Stage-1 detection classes. Kept small and page-visible; a bar is derived, not one of these. */
export type BoxClass = 'staff' | 'barline' | 'chordBand' | 'title';

export const BOX_CLASSES: readonly BoxClass[] = ['staff', 'barline', 'chordBand', 'title'];

/** A box in layout units. Multiply by `pxPerUnit` for the pixel region (see the imaging step). */
export interface UnitBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageObjectBox {
  cls: BoxClass;
  /** The class's index in `BOX_CLASSES` — the integer label a detector trains on. */
  clsId: number;
  box: UnitBox;
  /** The system this object belongs to (`LayoutSystem.index`), or null for page-level text. */
  system: number | null;
}

export interface PageBoxes {
  /** `LayoutPage.index`. */
  page: number;
  /** Page size in layout units, so the imaging step can scale boxes to the rendered pixels. */
  width: number;
  height: number;
  objects: PageObjectBox[];
}

export interface ExtractPageBoxesOptions {
  pageSpec?: PageSpecInput;
}

// --- Box shapes, in units. All derived from layout geometry, none tuned by eye. ---

/** A drawn barline is a thin vertical stroke; give its box this half-width in units so it is a box,
 * not a zero-width line the detector cannot regress. ~0.3 of a staff space, matching a printed rule. */
const BARLINE_HALF_WIDTH = 3;

/** Header text has no measured width here (no `measureText` — ADR-0015), so a title/composer box is
 * estimated from character count. A mean glyph advance of ~0.55·fontSize is close enough for a
 * *detection* label on synthetic renders, where the exact box only has to bound the ink loosely. */
const GLYPH_ADVANCE = 0.62;
/** Text descends below its baseline by about this fraction of the font size. */
const TEXT_DESCENT = 0.25;

function clampBox(box: UnitBox, pageWidth: number, pageHeight: number): UnitBox {
  const x = Math.max(0, Math.min(box.x, pageWidth));
  const y = Math.max(0, Math.min(box.y, pageHeight));
  const width = Math.max(0, Math.min(box.width, pageWidth - x));
  const height = Math.max(0, Math.min(box.height, pageHeight - y));
  return { x, y, width, height };
}

function titleBox(text: LayoutText): UnitBox {
  const width = Math.max(text.text.length * text.size * GLYPH_ADVANCE, text.size);
  const ascent = text.size;
  const height = ascent + text.size * TEXT_DESCENT;
  const left =
    text.align === 'center' ? text.x - width / 2 : text.align === 'right' ? text.x - width : text.x;
  return { x: left, y: text.y - ascent, width, height };
}

/**
 * Extract every Stage-1 detection box, page by page. Deterministic in the score (so, in the seed):
 * the same score always yields the same boxes, because they are read off `layout()`, which is pure.
 */
export function extractPageBoxes(score: Score, options: ExtractPageBoxesOptions = {}): PageBoxes[] {
  const result = layout(score, options.pageSpec ?? {});
  const staffHeight = result.pageSpec.staffHeight;
  const chordAscent = result.pageSpec.chordAscent;
  const clsId = (cls: BoxClass): number => BOX_CLASSES.indexOf(cls);

  const pages: PageBoxes[] = [];
  for (const page of result.pages) {
    const objects: PageObjectBox[] = [];
    const push = (cls: BoxClass, box: UnitBox, system: number | null): void => {
      const clamped = clampBox(box, page.width, page.height);
      if (clamped.width > 0 && clamped.height > 0) {
        objects.push({ cls, clsId: clsId(cls), box: clamped, system });
      }
    };

    // The title block sits on page 1 only; every header role (title/composer/style) is one text class.
    for (const text of page.header) push('title', titleBox(text), null);

    for (const system of page.systems) {
      // The 5-line staff: top line at `staveY`, four spaces (`staffHeight`) down to the bottom line.
      push('staff', { x: system.x, y: system.staveY, width: system.width, height: staffHeight }, system.index);

      // The chord band: the full-width strip where every chord symbol's baseline sits, present only
      // when the system carries chords (`chordBaselineOffset` is 0 otherwise). Ascends `chordAscent`
      // above its baseline; the baseline is `chordBaselineOffset` above the top staff line.
      if (system.chordBaselineOffset > 0) {
        const baseline = system.staveY - system.chordBaselineOffset;
        push('chordBand', { x: system.x, y: baseline - chordAscent, width: system.width, height: chordAscent }, system.index);
      }

      // A barline at each bar's right edge — the drawn dividers. The span between two of them is a
      // *bar*, derived downstream (`assemble.py`), never emitted as a box. Bars are contiguous, so the
      // right edges are exactly the interior dividers plus the closing barline.
      for (const bar of system.bars) {
        const edge = bar.x + bar.width;
        push('barline', { x: edge - BARLINE_HALF_WIDTH, y: system.staveY, width: BARLINE_HALF_WIDTH * 2, height: staffHeight }, system.index);
      }
    }

    pages.push({ page: page.index, width: page.width, height: page.height, objects });
  }
  return pages;
}
