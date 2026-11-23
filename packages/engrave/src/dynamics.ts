import { DYNAMICS_MID } from '@sibei/layout';
import type { Dynamic, HairpinShape } from '@sibei/model';
import type { MusicFont, MusicGlyphName } from './font.js';
import { units } from './font.js';
import type { SvgElement } from './svg.js';
import { el } from './svg.js';

/**
 * Dynamics and hairpins (SIB2-274, ADR-0021 amendment), drawn in one row under the staff. Layout reserved the row
 * (`dynamicsRow`) and hands the engraver its baseline; nothing here measures text. A dynamic is the music font's own
 * glyph, centred on its note by the glyph's advance, and a hairpin is two strokes.
 */

/** The SMuFL glyph of each marking; the combined ones (`ff`, `mf`) are single glyphs the font spaces itself. */
const DYNAMIC_GLYPHS: Record<Dynamic, MusicGlyphName> = {
  ppp: 'dynamicPPP',
  pp: 'dynamicPP',
  p: 'dynamicPiano',
  mp: 'dynamicMP',
  mf: 'dynamicMF',
  f: 'dynamicForte',
  ff: 'dynamicFF',
  fff: 'dynamicFFF',
  sf: 'dynamicSforzando1',
  sfz: 'dynamicSforzato',
  fp: 'dynamicFortePiano',
  rfz: 'dynamicRinforzando2',
};

/** The advance of a dynamic, so a hairpin can start after one and stop before the next. */
export function dynamicWidth(font: MusicFont, dynamic: Dynamic): number {
  return font.width(DYNAMIC_GLYPHS[dynamic]);
}

/** A dynamic centred on `centre`, its baseline at `y`. */
export function dynamicMark(font: MusicFont, dynamic: Dynamic, centre: number, y: number): SvgElement {
  const glyph = DYNAMIC_GLYPHS[dynamic];
  return font.element(glyph, centre - font.width(glyph) / 2, y);
}

/** How far a hairpin opens, and the least it is drawn when two dynamics crowd it. */
const HAIRPIN_OPENING = units(1.2);
const HAIRPIN_MIN = units(1.5);

export interface HairpinSpec {
  shape: HairpinShape;
  from: number;
  to: number;
  /** The row's baseline; the wedge is centred `DYNAMICS_MID` above it. */
  baseline: number;
}

/**
 * The wedge: a crescendo is a point on the left opening to the right, a diminuendo the reverse. A wedge that
 * neighbouring dynamics squeeze under the minimum is left out: a crushed wedge reads as a smudge on the dynamic.
 */
export function hairpin(spec: HairpinSpec): SvgElement | null {
  if (spec.to - spec.from < HAIRPIN_MIN) return null;
  const to = spec.to;
  const mid = spec.baseline - DYNAMICS_MID;
  const half = HAIRPIN_OPENING / 2;
  const [apexX, openX] = spec.shape === 'crescendo' ? [spec.from, to] : [to, spec.from];
  return el('path', {
    class: 'se-hairpin',
    d: `M${openX} ${mid - half}L${apexX} ${mid}L${openX} ${mid + half}`,
    fill: 'none',
    stroke: '#000000',
    'stroke-width': 1,
    'stroke-linejoin': 'miter',
  });
}
