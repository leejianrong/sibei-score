import { ARTICULATIONS } from '@sibei/model';
import type { Articulation } from '@sibei/model';
import { FERMATA_BASE, FERMATA_GAP } from '@sibei/layout';
import type { MusicFont, MusicGlyphName } from './font.js';
import { units } from './font.js';
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
/**
 * A fermata under its note (SIB2-233): where a stem-down voice's note takes it, or a note below the staff, so the mark sits
 * over the note's own side instead of crossing the staff to the far side of it. The glyph hangs from its origin, which
 * sits `FERMATA_BASE` under the bottom line, or `FERMATA_GAP` under the head's own ink when that is lower still.
 */
export function fermataBelow(font: MusicFont, anchor: { x: number; width: number; staveY: number; inkBottomY: number }): SvgElement {
  const fromStaff = anchor.staveY + units(4) + FERMATA_BASE;
  const fromInk = anchor.inkBottomY + FERMATA_GAP;
  return font.element('fermataBelow', anchor.x + anchor.width / 2 - font.width('fermataBelow') / 2, Math.max(fromStaff, fromInk));
}

export function fermata(font: MusicFont, anchor: MarkAnchor): SvgElement {
  const fromStaff = anchor.staveY - FERMATA_BASE;
  const fromInk = anchor.inkTopY === null ? fromStaff : anchor.inkTopY - FERMATA_GAP;
  const y = Math.min(fromStaff, fromInk);
  return font.element('fermataAbove', anchor.x + anchor.width / 2 - font.width('fermataAbove') / 2, y);
}

// ---------------------------------------------------------------------------
// Articulations (SIB2-179)
// ---------------------------------------------------------------------------

/** Clearance between a notehead's edge, or the previous mark, and the next mark. */
const ARTICULATION_GAP = units(0.3);
/** A notehead is a staff space tall, so its edge is half a space off its centre. */
const HEAD_HALF = units(0.5);

const MARK_GLYPHS: Record<Articulation, { above: MusicGlyphName; below: MusicGlyphName }> = {
  staccato: { above: 'articStaccatoAbove', below: 'articStaccatoBelow' },
  accent: { above: 'articAccentAbove', below: 'articAccentBelow' },
  marcato: { above: 'articMarcatoAbove', below: 'articMarcatoBelow' },
};

export interface ArticulationAnchor {
  x: number;
  width: number;
  /** The notehead's centre, y-down. */
  y: number;
  staveY: number;
  /** Marks go on the notehead side, so away from the stem: `down` stems put them above. */
  stem: 'up' | 'down';
  marks: readonly Articulation[];
}

/**
 * The marks on one note, stacked away from the head in `ARTICULATIONS` order (staccato nearest). SMuFL draws
 * each `Above`/`Below` glyph with its origin on the edge nearest the head, so the origin is where the mark
 * starts. The first mark that would land on a staff line is moved to the next space away from the note, the
 * convention for a staccato dot; further marks stack beyond it. The layout reserved `ARTICULATION_BAND` per
 * mark above or below the head, which is what keeps the chord band from landing on them.
 */
export function articulations(font: MusicFont, anchor: ArticulationAnchor): SvgElement[] {
  const above = anchor.stem === 'down';
  const sign = above ? -1 : 1;
  const out: SvgElement[] = [];
  let edge = anchor.y + sign * (HEAD_HALF + ARTICULATION_GAP);
  let first = true;
  for (const mark of ARTICULATIONS) {
    if (!anchor.marks.includes(mark)) continue;
    const name = MARK_GLYPHS[mark][above ? 'above' : 'below'];
    const box = font.box(name);
    const height = Math.abs(box.height);
    if (first) {
      const centre = edge + sign * (height / 2);
      const inStaff = centre >= anchor.staveY && centre <= anchor.staveY + units(4);
      if (inStaff) {
        const space = (centre - anchor.staveY - units(0.5)) / units(1);
        const snapped = anchor.staveY + units(0.5) + units(above ? Math.floor(space) : Math.ceil(space));
        edge = snapped - sign * (height / 2);
      }
      first = false;
    }
    out.push(font.element(name, anchor.x + anchor.width / 2 - font.width(name) / 2, edge));
    edge += sign * (height + ARTICULATION_GAP);
  }
  return out;
}
