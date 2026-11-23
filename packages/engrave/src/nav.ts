import { NAV_SIGNS, NAV_TEXT } from '@sibei/model';
import type { NavKind } from '@sibei/model';
import { NAV_BAND } from '@sibei/layout';
import type { MusicFont } from './font.js';
import { units } from './font.js';
import type { SvgElement } from './svg.js';
import { text } from './text.js';

/**
 * Navigation marks (SIB2-175, ADR-0021 amendment), in the row layout reserved above everything else.
 *
 * A segno or coda is the font's own glyph, standing on the row's floor at the bar's start. A jump ("D.S. al Coda")
 * is bold italic text right-aligned at the bar's end, as the Real Book sets it. Both place by `text-anchor` and the
 * glyph's published box, never by measuring text (ADR-0015).
 *
 * `top` is the top of the row, the system's `bands.top`.
 */
export interface NavSpec {
  kind: NavKind;
  /** The bar's start (after its clef, key and time signature) and end. */
  start: number;
  end: number;
  top: number;
  fontSize: number;
}

/** The signs are drawn smaller than a notehead-sized glyph, so a Petaluma coda still fits the row. */
const SIGN_SCALE = 0.8;
const FLOOR_GAP = units(0.4);

export function navMark(font: MusicFont, spec: NavSpec): SvgElement[] {
  const floor = spec.top + NAV_BAND - FLOOR_GAP;
  if (NAV_SIGNS.includes(spec.kind)) {
    const name = spec.kind === 'segno' ? 'segno' : 'coda';
    const box = font.box(name);
    // The glyph's ink bottom sits on the floor; `box.bottom` is its depth below the origin (y-down).
    return [font.element(name, spec.start, floor - box.bottom * SIGN_SCALE, SIGN_SCALE)];
  }
  return [
    text({
      text: NAV_TEXT[spec.kind] ?? '',
      x: spec.end,
      y: floor - units(0.3),
      size: spec.fontSize,
      align: 'right',
      weight: 'bold',
      style: 'italic',
      class: 'se-nav',
    }),
  ];
}
