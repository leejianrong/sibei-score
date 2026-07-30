import type { Duration } from '@sibei/model';
import type { BravuraGlyphName } from './bravura.js';
import { INK, anchor, glyphWidth, units } from './bravura.js';
import { MIDDLE_LINE, positionY } from './staff.js';
import type { SvgElement } from './svg.js';
import { el } from './svg.js';

/**
 * Noteheads and stems.
 *
 * The stem's position is not chosen: SMuFL publishes, per notehead, the exact point at
 * which a stem meets it — `stemUpSE` for the bottom-right corner of an upward stem,
 * `stemDownNW` for the top-left corner of a downward one. Reading those instead of
 * guessing "the right-hand edge, a bit above centre" is the whole of ADR-0030's first
 * build step, and it is why this file has no tuning constants in it.
 *
 * The stem's *length* is not in the font, because it is a matter of convention rather
 * than of the glyph. Two conventions, both Gould's: three and a half spaces as
 * standard, and always at least as far as the middle line for a note outside the staff.
 */

export type StemDirection = 'up' | 'down';

/** Gould: a stem is three and a half staff spaces long. */
export const STANDARD_STEM = units(3.5);

export function noteheadFor(duration: Duration): BravuraGlyphName {
  if (duration.value === 1) return 'noteheadWhole';
  if (duration.value === 2) return 'noteheadHalf';
  return 'noteheadBlack';
}

/** A whole note has no stem; everything shorter does. */
export function hasStem(duration: Duration): boolean {
  return duration.value > 1;
}

/**
 * How many beams or flags a duration carries. One for an eighth, two for a sixteenth.
 */
export function beamCount(duration: Duration): number {
  if (duration.value < 8) return 0;
  return Math.round(Math.log2(duration.value / 4));
}

/**
 * Single voice throughout (ADR-0021), so stem direction is decided by the note alone:
 * away from the middle line, and **down** for a note sitting on it. The note on the
 * line is the case worth stating, because either direction looks plausible and only one
 * is conventional — bar 8's Bb4 is where the first version of this got it wrong, caught
 * by putting it next to VexFlow.
 */
export function stemDirection(position: number): StemDirection {
  return position <= MIDDLE_LINE ? 'down' : 'up';
}

/**
 * A beamed group takes one direction for all of it, chosen by the note furthest from
 * the middle line. A tie goes down, which is the convention for a group balanced about
 * the middle.
 */
export function groupStemDirection(positions: readonly number[]): StemDirection {
  let extreme = 0;
  for (const position of positions) {
    const distance = position - MIDDLE_LINE;
    if (Math.abs(distance) > Math.abs(extreme)) extreme = distance;
  }
  return extreme > 0 ? 'up' : 'down';
}

export interface Stem {
  direction: StemDirection;
  /** Left edge of the stem rectangle. */
  left: number;
  right: number;
  /** Centre of the stem, which is what a beam's slope is measured along. */
  centre: number;
  /** Where the stem meets the notehead. */
  attachY: number;
  /** The free end. Beaming moves this; nothing else does. */
  endY: number;
}

export interface StemInput {
  notehead: BravuraGlyphName;
  direction: StemDirection;
  /** Left edge of the notehead. */
  noteX: number;
  /** The note's staff position, in half spaces below the top line. */
  position: number;
  staveY: number;
}

/**
 * The stem for one note, before any beam has had its say.
 *
 * `stemUpSE` is where the *bottom right* corner of an upward stem meets the notehead,
 * so the stem hangs to the left of that x. `stemDownNW` is the *top left* corner of a
 * downward stem, so that one hangs to the right. Getting this backwards puts the stem a
 * stem's width out of place, which looks like a slightly fat notehead rather than like
 * a bug — hence the unit test.
 */
export function stem(input: StemInput): Stem {
  const noteY = positionY(input.position, input.staveY);
  const middleY = positionY(MIDDLE_LINE, input.staveY);

  if (input.direction === 'up') {
    const point = anchor(input.notehead, 'stemUpSE');
    const right = input.noteX + point.x;
    return {
      direction: 'up',
      left: right - INK.stem,
      right,
      centre: right - INK.stem / 2,
      attachY: noteY + point.y,
      // A note below the staff keeps its stem reaching the middle line.
      endY: Math.min(noteY - STANDARD_STEM, middleY),
    };
  }

  const point = anchor(input.notehead, 'stemDownNW');
  const left = input.noteX + point.x;
  return {
    direction: 'down',
    left,
    right: left + INK.stem,
    centre: left + INK.stem / 2,
    attachY: noteY + point.y,
    endY: Math.max(noteY + STANDARD_STEM, middleY),
  };
}

export function stemElement(value: Stem): SvgElement {
  const top = Math.min(value.attachY, value.endY);
  const bottom = Math.max(value.attachY, value.endY);
  return el('rect', {
    class: 'se-stem',
    x: value.left,
    y: top,
    width: INK.stem,
    height: bottom - top,
    fill: '#000000',
  });
}

/**
 * The flag on an unbeamed short note. SMuFL anchors this one too: `stemUpNW` is the
 * point on the flag that the top-left corner of the stem meets, so the flag is placed
 * by putting that anchor where the stem ends rather than by nudging it into position.
 */
export function flagFor(duration: Duration, direction: StemDirection): BravuraGlyphName | null {
  const count = beamCount(duration);
  const suffix = direction === 'up' ? 'Up' : 'Down';
  switch (count) {
    case 0:
      return null;
    case 1:
      return `flag8th${suffix}`;
    case 2:
      return `flag16th${suffix}`;
    default:
      // Nothing shorter than a thirty-second exists in the model's vocabulary.
      return `flag32nd${suffix}`;
  }
}

/** Where a flag glyph's origin goes, so that its stem anchor lands on the stem's end. */
export function flagOrigin(flag: BravuraGlyphName, value: Stem): { x: number; y: number } {
  // Both anchors name the same thing from the flag's side: the corner of the stem's
  // free end that the flag joins. Up stems end top-left, down stems bottom-left.
  const point = anchor(flag, value.direction === 'up' ? 'stemUpNW' : 'stemDownSW');
  return { x: value.left - point.x, y: value.endY - point.y };
}

/**
 * An augmentation dot sits in the space after the notehead, and moves to the space
 * above when the note is on a line — a dot on a line is unreadable.
 */
export function dotPositions(
  duration: Duration,
  notehead: BravuraGlyphName,
  noteX: number,
  position: number,
  staveY: number,
): { x: number; y: number }[] {
  const gap = units(0.3);
  const advance = glyphWidth('augmentationDot') + gap;
  const onLine = position % 2 === 0;
  const y = positionY(onLine ? position - 1 : position, staveY);
  const first = noteX + glyphWidth(notehead) + gap;
  return Array.from({ length: duration.dots }, (_, index) => ({
    x: first + index * advance,
    y,
  }));
}
