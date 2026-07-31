import { STAFF_SPACE } from '@sibei/layout';
import type { SvgElement } from './svg.js';
import { el, num } from './svg.js';

/**
 * A SMuFL music font, in layout's units.
 *
 * **Why this is an object rather than a module of constants.** A lead sheet is read in a
 * handwritten Real Book face as often as an engraved one, and the choice is the reader's,
 * per render — so the engraver cannot bind a font at import time. Every geometry function
 * therefore takes a `MusicFont`, and swapping Bravura for Petaluma is an argument rather
 * than a rebuild.
 *
 * Nothing here is derived, measured or tuned. Thicknesses come from the font's
 * `engravingDefaults`, attachment points from the glyphs' own SMuFL anchors, and this
 * module does nothing but change the units. That the two faces disagree about the numbers
 * is the point: Bravura attaches an up stem at `[1.18, 0.168]` staff spaces and Petaluma
 * at `[1.336, 0.288]`, so a hand-tuned offset would be wrong for one of them and an
 * anchor is right for both (ADR-0030).
 *
 * Three coordinate systems meet here, so they are worth naming once:
 *
 * - **staff spaces**, SMuFL's unit for every metric. y-up.
 * - **font units**, the outlines. A few hundred to a staff space, y-up, and the number
 *   is the font's own — `fontUnitsPerStaffSpace`.
 * - **layout units**, ours. 10 to a staff space (`STAFF_SPACE`), y-**down**, because
 *   that is how a page is addressed.
 *
 * The y flip is the one thing to get right, and it is done in exactly two places: the
 * anchor lookup, and the glyph transform.
 */

/** Staff spaces to layout units. */
export function units(staffSpaces: number): number {
  return staffSpaces * STAFF_SPACE;
}

/**
 * Every glyph the engraver draws. A generated font module must supply all of them, which
 * is what stops a second face being half a face.
 */
export type MusicGlyphName =
  | 'noteheadWhole'
  | 'noteheadHalf'
  | 'noteheadBlack'
  | 'flag8thUp'
  | 'flag8thDown'
  | 'flag16thUp'
  | 'flag16thDown'
  | 'flag32ndUp'
  | 'flag32ndDown'
  | 'accidentalDoubleFlat'
  | 'accidentalFlat'
  | 'accidentalNatural'
  | 'accidentalSharp'
  | 'accidentalDoubleSharp'
  | 'augmentationDot';

/** Every `engravingDefaults` value the engraver reads, in staff spaces. */
export interface EngravingDefaults {
  readonly staffLineThickness: number;
  readonly stemThickness: number;
  readonly beamThickness: number;
  readonly beamSpacing: number;
  readonly legerLineThickness: number;
  readonly legerLineExtension: number;
}

export interface GlyphData {
  /** SMuFL codepoint, for provenance rather than for drawing. */
  readonly codepoint: string;
  /** Advance width in staff spaces. */
  readonly advance: number;
  readonly bBoxSW: readonly [number, number];
  readonly bBoxNE: readonly [number, number];
  /** SMuFL attachment points, in staff spaces from the glyph's origin, y-up. */
  readonly anchors: Readonly<Record<string, readonly [number, number]>>;
  /** SVG path data in font units, y-up, verbatim from the font. */
  readonly path: string;
}

/** What a generated font module exports. */
export interface MusicFontData {
  readonly name: string;
  readonly version: string;
  /** Where the data came from, for the record. */
  readonly source: string;
  readonly fontUnitsPerStaffSpace: number;
  readonly engravingDefaults: EngravingDefaults;
  readonly glyphs: Readonly<Record<MusicGlyphName, GlyphData>>;
}

export interface Point {
  x: number;
  y: number;
}

/** Every thickness the engraver draws with, in layout units. */
export interface Ink {
  staffLine: number;
  stem: number;
  beam: number;
  /** Gap between one beam and the next, measured between their facing edges. */
  beamGap: number;
  ledgerLine: number;
  /** How far a ledger line sticks out past the notehead, each side. */
  ledgerExtension: number;
}

export interface MusicFont {
  readonly data: MusicFontData;
  readonly ink: Ink;
  /** Distance between the outer edges of consecutive beams. */
  readonly beamPitch: number;
  /** A glyph's advance width, in layout units. */
  width(name: MusicGlyphName): number;
  anchor(name: MusicGlyphName, anchorName: string): Point;
  hasAnchor(name: MusicGlyphName, anchorName: string): boolean;
  /** Place a glyph with its origin at (x, y). */
  element(name: MusicGlyphName, x: number, y: number): SvgElement;
}

/**
 * Resolve a font's published data into the units and shapes the engraver works in.
 *
 * A from-scratch engraver that invents the thicknesses below is how output starts looking
 * subtly amateur, which is the failure mode ADR-0030 names. None of them are invented.
 */
export function musicFont(data: MusicFontData): MusicFont {
  const defaults = data.engravingDefaults;
  const ink: Ink = {
    staffLine: units(defaults.staffLineThickness),
    stem: units(defaults.stemThickness),
    beam: units(defaults.beamThickness),
    beamGap: units(defaults.beamSpacing),
    ledgerLine: units(defaults.legerLineThickness),
    ledgerExtension: units(defaults.legerLineExtension),
  };

  // The outlines are in the font's own units; ours are ten to the staff space.
  const scale = STAFF_SPACE / data.fontUnitsPerStaffSpace;

  return {
    data,
    ink,
    beamPitch: ink.beam + ink.beamGap,

    width(name) {
      return units(data.glyphs[name].advance);
    },

    /**
     * A SMuFL anchor as an offset from the glyph's origin, in layout units and y-down.
     *
     * Missing is an error rather than a zero. An anchor the font does not publish means
     * either the wrong glyph or the wrong anchor name, and both are bugs that would
     * otherwise show up as a stem attached to the notehead's origin — which is very
     * nearly right, and so would survive review.
     */
    anchor(name, anchorName) {
      const point = data.glyphs[name].anchors[anchorName];
      if (point === undefined) {
        throw new Error(`${data.name}'s ${name} has no ${anchorName} anchor`);
      }
      return { x: units(point[0]), y: -units(point[1]) };
    },

    hasAnchor(name, anchorName) {
      return data.glyphs[name].anchors[anchorName] !== undefined;
    },

    /**
     * The outline is the font's path data unchanged, positioned by a transform:
     * translate to the origin, then scale into layout units with the y axis flipped.
     * Rewriting the path would be the alternative, and it would mean this project owning
     * a path parser and a copy of the outlines that no longer matches the font.
     */
    element(name, x, y) {
      return el('path', {
        class: `se-glyph se-${name}`,
        transform: `translate(${num(x)},${num(y)}) scale(${num(scale)},${num(-scale)})`,
        d: data.glyphs[name].path,
        fill: '#000000',
        stroke: 'none',
      });
    },
  };
}
