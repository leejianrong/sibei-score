import type { MusicFont, MusicGlyphName } from './font.js';
import { units } from './font.js';
import { flagOrigin, stemElement } from './stems.js';
import type { SvgElement } from './svg.js';
import { text } from './text.js';

/**
 * A metronome mark (SIB2-177): a small note, `=`, and the number — drawn from the notehead, stem, flag and dot
 * glyphs the engraver already has, so it needs no extra font slice and works in both faces. The stem is shorter
 * than a staff note's (a mark is an annotation, not music), and the digits are text placed with `text-anchor`,
 * never measured (ADR-0015); the note's own width comes from the font.
 *
 * `top` is the top of the band layout reserved above the staff, as `rehearsalMark`'s is.
 */
export interface TempoSpec {
  unit: { value: number; dots: number };
  bpm: number;
}

const STEM = units(2.2);
const NOTE_BASELINE = units(2.2) + units(0.5);

export function tempoMark(font: MusicFont, spec: TempoSpec, x: number, top: number, size: number): SvgElement[] {
  const out: SvgElement[] = [];
  const notehead: MusicGlyphName =
    spec.unit.value === 1 ? 'noteheadWhole' : spec.unit.value === 2 ? 'noteheadHalf' : 'noteheadBlack';
  const y = top + NOTE_BASELINE;
  out.push(font.element(notehead, x, y));
  let right = x + font.width(notehead);

  if (spec.unit.value > 1) {
    const anchor = font.anchor(notehead, 'stemUpSE');
    const stemRight = x + anchor.x;
    const attachY = y + anchor.y;
    const value = {
      direction: 'up' as const,
      left: stemRight - font.ink.stem,
      right: stemRight,
      centre: stemRight - font.ink.stem / 2,
      attachY,
      endY: attachY - STEM,
      thickness: font.ink.stem,
    };
    out.push(stemElement(value));
    if (spec.unit.value === 8) {
      const flag: MusicGlyphName = 'flag8thUp';
      const origin = flagOrigin(font, flag, value);
      out.push(font.element(flag, origin.x, origin.y));
      right = Math.max(right, origin.x + font.width(flag));
    }
  }

  if (spec.unit.dots === 1) {
    const dotX = right + units(0.3);
    out.push(font.element('augmentationDot', dotX, y - units(0.5)));
    right = dotX + font.width('augmentationDot');
  }

  out.push(
    text({
      text: `= ${spec.bpm}`,
      x: right + units(0.6),
      y: y + size * 0.3,
      size,
      align: 'left',
      weight: 'bold',
      class: 'se-tempo',
    }),
  );
  return out;
}

