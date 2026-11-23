import type { Clef, TimeSignature } from '@sibei/model';
import type { Digit, MusicFont, MusicGlyphName } from './font.js';
import { units } from './font.js';
import { clefTopOffset, positionY } from './staff.js';
import type { SvgElement } from './svg.js';

/**
 * The bar prefix: clef, key signature, time signature.
 *
 * All three are placed inside the room layout already allocated for them
 * (`LayoutBar.prefixWidth`), so the adapter draws within a box rather than deciding how
 * wide the box is. Which is the seam working: layout sized every bar around this number
 * and now publishes it, so both adapters put a bar's first notehead in the same place.
 *
 * Treble clef only, which is all the model has (ADR-0021).
 */

/** The G line: second from the bottom, which is where a G clef's origin sits. */
const G_LINE = 6;

/**
 * The clef glyph and the staff position its origin sits on (ADR-0041, slice 4). SMuFL draws each clef around the line
 * it names: G on the second line from the bottom, F on the fourth (the second from the top), C on the middle line
 * (alto) or the fourth (tenor); the unpitched percussion clef is centred on the middle line.
 */
const CLEFS: Record<Clef, { glyph: MusicGlyphName; line: number }> = {
  treble: { glyph: 'gClef', line: G_LINE },
  bass: { glyph: 'fClef', line: 2 },
  alto: { glyph: 'cClef', line: 4 },
  tenor: { glyph: 'cClef', line: 2 },
  percussion: { glyph: 'unpitchedPercussionClef1', line: 4 },
};

/** A clef change in mid-system is drawn at this fraction of the opening clef's size (Gould, SIB2-241). */
export const CLEF_CHANGE_SIZE = 0.75;

export function clef(font: MusicFont, x: number, staveY: number, kind: Clef = 'treble', size = 1): SvgElement {
  const spec = CLEFS[kind];
  return font.element(spec.glyph, x, positionY(spec.line, staveY), size);
}

export function clefWidth(font: MusicFont, kind: Clef = 'treble'): number {
  return font.width(CLEFS[kind].glyph);
}

/**
 * Where each accidental of a key signature sits, in the order it is written.
 *
 * These are staff positions, not a formula: the conventional treble-clef layout keeps
 * the run of accidentals inside the staff and reading downward-then-up, which no rule
 * about octaves reproduces on its own.
 */
const SHARP_POSITIONS = [0, 3, -1, 2, 5, 1, 4];
const FLAT_POSITIONS = [4, 1, 5, 2, 6, 3, 7];

/** Room each key accidental takes, a little tighter than a standalone one. */
const KEY_ACCIDENTAL_GAP = units(0.15);

export interface KeySignatureLayout {
  elements: SvgElement[];
  width: number;
}

/**
 * A key signature's staff positions in another clef: the treble pattern moved by the clef's distance from treble,
 * and any accidental pushed off the staff folded back an octave, which is how every clef keeps the run inside the
 * staff (alto and bass are the treble pattern one and two steps down, tenor one up with the top sharps wrapped).
 * Treble is the table itself, untouched.
 */
function positionsIn(table: readonly number[], kind: Clef): readonly number[] {
  if (kind === 'treble') return table;
  const shift = ((clefTopOffset(kind) % 7) + 7) % 7;
  // The smallest move that lands the pattern in the staff: tenor goes up one, the others down.
  const move = shift > 3 ? shift - 7 : shift;
  return table.map((position) => {
    let moved = position + move;
    while (moved < -1) moved += 7;
    while (moved > 8) moved -= 7;
    return moved;
  });
}

export function keySignature(
  font: MusicFont,
  fifths: number,
  x: number,
  staveY: number,
  kind: Clef = 'treble',
): KeySignatureLayout {
  const sharps = fifths > 0;
  const count = Math.min(Math.abs(fifths), 7);
  const glyph: MusicGlyphName = sharps ? 'accidentalSharp' : 'accidentalFlat';
  const positions = positionsIn(sharps ? SHARP_POSITIONS : FLAT_POSITIONS, kind);
  const step = font.width(glyph) + KEY_ACCIDENTAL_GAP;

  const elements: SvgElement[] = [];
  for (let index = 0; index < count; index += 1) {
    const position = positions[index];
    if (position === undefined) continue;
    elements.push(font.element(glyph, x + index * step, positionY(position, staveY)));
  }
  return { elements, width: count * step };
}

/** Numerator on the second line down, denominator on the fourth: the usual stacking. */
const NUMERATOR_LINE = 2;
const DENOMINATOR_LINE = 6;

export interface TimeSignatureLayout {
  elements: SvgElement[];
  width: number;
}

export function timeSignature(
  font: MusicFont,
  time: TimeSignature,
  x: number,
  staveY: number,
): TimeSignatureLayout {
  const top = digits(time.beats);
  const bottom = digits(time.beatValue);
  const topWidth = runWidth(font, top, 'timeSig');
  const bottomWidth = runWidth(font, bottom, 'timeSig');
  const width = Math.max(topWidth, bottomWidth);

  return {
    elements: [
      ...run(font, top, 'timeSig', x + (width - topWidth) / 2, positionY(NUMERATOR_LINE, staveY)),
      ...run(
        font,
        bottom,
        'timeSig',
        x + (width - bottomWidth) / 2,
        positionY(DENOMINATOR_LINE, staveY),
      ),
    ],
    width,
  };
}

export function digits(value: number): Digit[] {
  return [...Math.abs(Math.trunc(value)).toString()].map((character) => Number(character) as Digit);
}

/** A run of SMuFL digits, laid out left to right on one baseline. */
export function run(
  font: MusicFont,
  values: readonly Digit[],
  family: 'timeSig' | 'tuplet',
  x: number,
  y: number,
): SvgElement[] {
  const elements: SvgElement[] = [];
  let cursor = x;
  for (const value of values) {
    const glyph = `${family}${value}` as MusicGlyphName;
    elements.push(font.element(glyph, cursor, y));
    cursor += font.width(glyph);
  }
  return elements;
}

export function runWidth(
  font: MusicFont,
  values: readonly Digit[],
  family: 'timeSig' | 'tuplet',
): number {
  return values.reduce<number>(
    (sum, value) => sum + font.width(`${family}${value}` as MusicGlyphName),
    0,
  );
}
