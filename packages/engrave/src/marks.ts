import { FERMATA_BASE, FERMATA_GAP } from '@sibei/layout';
import type { MusicFont } from './font.js';
import type { SvgElement } from './svg.js';

/**
 * Marks over a note or rest: fermatas (SIB2-183) here, articulations alongside them later.
 *
 * Nothing here measures text; the glyph's own advance centres it over the notehead, and the heights are the
 * same layout constants `systemVertical` reserved room for, so what is drawn is what was made room for.
 */

export interface MarkAnchor {
  /** Left edge of the notehead or rest glyph, and its advance. */
  x: number;
  width: number;
  /** The y of the top staff line. */
  staveY: number;
  /** The highest ink of the note itself (head, or stem tip when the stem is up); null for a rest. */
  inkTopY: number | null;
}

/**
 * A fermata, centred over its note or rest, above the staff and above the note's own ink. Its baseline (the
 * dot) sits `FERMATA_BASE` over the top staff line, or `FERMATA_GAP` over a taller note or stem.
 */
export function fermata(font: MusicFont, anchor: MarkAnchor): SvgElement {
  const fromStaff = anchor.staveY - FERMATA_BASE;
  const fromInk = anchor.inkTopY === null ? fromStaff : anchor.inkTopY - FERMATA_GAP;
  const y = Math.min(fromStaff, fromInk);
  return font.element('fermataAbove', anchor.x + anchor.width / 2 - font.width('fermataAbove') / 2, y);
}
