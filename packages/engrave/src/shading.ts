import { units } from './font.js';
import { BOTTOM_LINE, TOP_LINE, positionY } from './staff.js';
import type { SvgElement } from './svg.js';
import { el } from './svg.js';

/**
 * Review shading (V14c, ADR-0013, ADR-0019): a pale wash the engraver lays *behind* the
 * glyphs so a reader can see what an import flagged.
 *
 * Two restrained treatments, both driven only by what layout already carries — nothing
 * here decides *whether* to shade. `LayoutBar.metrics.valid` says a bar's rhythm does not
 * fill the meter (ADR-0013), and a `flagged` layout item is an object the recogniser was
 * unsure of (ADR-0019). Which of those is true is layout's call; this file only draws it,
 * the same division of labour ADR-0014 draws everywhere else.
 *
 * A wash, not an outline, and it is emitted first (see `engraveSystem`) so every stroke of
 * ink lands on top of it — a highlight, never an occlusion. Both fills are pale enough to
 * read black notation cleanly over, on screen and on a printed page. The two hues are kept
 * distinct on purpose: a rhythm that does not add up is a different worry from a symbol the
 * recogniser could not read, and a reader should be able to tell them apart at a glance.
 */

/** Pale rose under a bar whose durations do not fill the meter (ADR-0013). */
export const INVALID_BAR_FILL = '#fbe0da';

/** Pale yellow behind an object the recogniser flagged for review (ADR-0019). */
export const FLAGGED_OBJECT_FILL = '#fdf1b8';

/** Air above the top line and below the bottom line a staff-height wash leaves, in staff spaces. */
const BAND_PAD = 0.6;

/** The vertical band a staff-height wash spans: the five lines, plus a little air each side. */
function staffBand(staveY: number): { y: number; height: number } {
  const top = positionY(TOP_LINE, staveY) - units(BAND_PAD);
  const bottom = positionY(BOTTOM_LINE, staveY) + units(BAND_PAD);
  return { y: top, height: bottom - top };
}

/** A wash across a whole bar box, the width layout allocated the bar (ADR-0013). */
export function invalidBarShade(x: number, width: number, staveY: number): SvgElement {
  const band = staffBand(staveY);
  return el('rect', {
    class: 'se-invalidbar',
    x,
    y: band.y,
    width,
    height: band.height,
    fill: INVALID_BAR_FILL,
  });
}

/** Room either side of a flagged notehead's column, so the stripe is not flush to the ink. */
const ITEM_PAD = 0.3;

/**
 * A highlighter stripe down a flagged note or rest's column. `x`/`width` are the notehead's
 * own box, from the same placement layout gave every other glyph, so nothing is measured
 * (ADR-0015).
 */
export function flaggedItemShade(x: number, width: number, staveY: number): SvgElement {
  const band = staffBand(staveY);
  const pad = units(ITEM_PAD);
  return el('rect', {
    class: 'se-flagged',
    x: x - pad,
    y: band.y,
    width: width + pad * 2,
    height: band.height,
    fill: FLAGGED_OBJECT_FILL,
  });
}

/**
 * A wash behind a flagged chord symbol or annotation. Its box is sized from the font size
 * and the character count rather than from a measurement — the same technique
 * `rehearsalMark` and the stacked-alteration run use, and for the same reason (ADR-0015).
 * The estimate is deliberately generous: a highlight that stops short of the text it marks
 * reads worse than one that runs a shade past it.
 */
const CHORD_ADVANCE = 0.6;
const CHORD_PAD_X = 0.25;
const CHORD_PAD_Y = 0.2;

export function flaggedChordShade(
  x: number,
  textLength: number,
  baseline: number,
  size: number,
): SvgElement {
  const padX = size * CHORD_PAD_X;
  const padY = size * CHORD_PAD_Y;
  const width = size * CHORD_ADVANCE * textLength + padX * 2;
  const height = size + padY * 2;
  return el('rect', {
    class: 'se-flagged',
    x: x - padX,
    y: baseline - size,
    width,
    height,
    fill: FLAGGED_OBJECT_FILL,
  });
}
