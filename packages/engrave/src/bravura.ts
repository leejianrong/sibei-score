import { STAFF_SPACE } from '@sibei/layout';
import type { BravuraGlyph, BravuraGlyphName } from './bravura.generated.js';
import {
  BRAVURA_GLYPHS,
  ENGRAVING_DEFAULTS,
  FONT_UNITS_PER_STAFF_SPACE,
} from './bravura.generated.js';
import type { SvgElement } from './svg.js';
import { el, num } from './svg.js';

/**
 * Bravura, in layout's units.
 *
 * The point of ADR-0030's first build step: the metrics problem is already solved as
 * data, so nothing here is derived, measured or tuned. Every number the engraver uses
 * comes out of `bravura_metadata.json` — thicknesses from `engravingDefaults`,
 * attachment points from the glyphs' own SMuFL anchors — and this module does nothing
 * but change the units.
 *
 * Three coordinate systems meet here, so they are worth naming once:
 *
 * - **staff spaces**, SMuFL's unit for every metric. y-up.
 * - **font units**, Bravura's outlines. 250 to a staff space, y-up.
 * - **layout units**, ours. 10 to a staff space (`STAFF_SPACE`), y-**down**, because
 *   that is how a page is addressed.
 *
 * The y flip is the one thing to get right, and it is done in exactly two places: the
 * anchor lookup below, and the glyph transform.
 */

export type { BravuraGlyph, BravuraGlyphName };
export { BRAVURA_SOURCE } from './bravura.generated.js';

/** Staff spaces to layout units. */
export function units(staffSpaces: number): number {
  return staffSpaces * STAFF_SPACE;
}

/** Bravura's outlines are 250 units to the staff space; ours are 10. */
const GLYPH_SCALE = STAFF_SPACE / FONT_UNITS_PER_STAFF_SPACE;

/**
 * Every thickness the engraver draws with, in layout units, straight from Bravura's
 * `engravingDefaults`. A from-scratch engraver that invents these is how output starts
 * looking subtly amateur, which is the failure mode ADR-0030 names.
 */
export const INK = {
  staffLine: units(ENGRAVING_DEFAULTS.staffLineThickness),
  stem: units(ENGRAVING_DEFAULTS.stemThickness),
  beam: units(ENGRAVING_DEFAULTS.beamThickness),
  /** Gap between one beam and the next, measured between their facing edges. */
  beamGap: units(ENGRAVING_DEFAULTS.beamSpacing),
  ledgerLine: units(ENGRAVING_DEFAULTS.legerLineThickness),
  /** How far a ledger line sticks out past the notehead, each side. */
  ledgerExtension: units(ENGRAVING_DEFAULTS.legerLineExtension),
} as const;

/** Distance between the outer edges of consecutive beams. */
export const BEAM_PITCH = INK.beam + INK.beamGap;

/**
 * The generated table keeps every value as a literal type, which is how `satisfies`
 * proves the data matches `BravuraGlyph` at build time. Reading it wants the widened
 * view, so that is what the accessors below go through.
 */
const GLYPHS: Readonly<Record<BravuraGlyphName, BravuraGlyph>> = BRAVURA_GLYPHS;

/** A glyph's advance width, in layout units. */
export function glyphWidth(name: BravuraGlyphName): number {
  return units(GLYPHS[name].advance);
}

export interface Point {
  x: number;
  y: number;
}

/**
 * A SMuFL anchor as an offset from the glyph's origin, in layout units and y-down.
 *
 * Missing is an error rather than a zero. An anchor the font does not publish means
 * either the wrong glyph or the wrong anchor name, and both are bugs that would
 * otherwise show up as a stem attached to the notehead's origin — which is very nearly
 * right, and so would survive review.
 */
export function anchor(name: BravuraGlyphName, anchorName: string): Point {
  const point = GLYPHS[name].anchors[anchorName];
  if (point === undefined) {
    throw new Error(`Bravura's ${name} has no ${anchorName} anchor`);
  }
  return { x: units(point[0]), y: -units(point[1]) };
}

export function hasAnchor(name: BravuraGlyphName, anchorName: string): boolean {
  return GLYPHS[name].anchors[anchorName] !== undefined;
}

/**
 * Place a glyph with its origin at (x, y).
 *
 * The outline is Bravura's path data unchanged, positioned by a transform: translate to
 * the origin, then scale into layout units with the y axis flipped. Rewriting the path
 * would be the alternative, and it would mean this project owning a path parser and a
 * copy of the outlines that no longer matches the font.
 */
export function glyphElement(name: BravuraGlyphName, x: number, y: number): SvgElement {
  return el('path', {
    class: `se-glyph se-${name}`,
    transform: `translate(${num(x)},${num(y)}) scale(${num(GLYPH_SCALE)},${num(-GLYPH_SCALE)})`,
    d: GLYPHS[name].path,
    fill: '#000000',
    stroke: 'none',
  });
}
