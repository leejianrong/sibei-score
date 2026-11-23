import { STAFF_SPACE } from '@sibei/layout';
import type { Clef, Pitch } from '@sibei/model';
import { STEPS } from '@sibei/model';
import type { MusicFont } from './font.js';
import type { SvgElement } from './svg.js';
import { el } from './svg.js';

/**
 * Where a pitch sits on the staff, and where the staff's own lines are.
 *
 * Positions are counted in **half spaces from the top line, downwards**, because that
 * is the coordinate the rest of the engraver wants: it is an integer for every
 * diatonic step, even numbers are lines and odd numbers are spaces, and it grows the
 * same way page y does.
 *
 *   -2  A5   first ledger line above
 *   -1  G5
 *    0  F5   top line
 *    4  B4   middle line
 *    8  E4   bottom line
 *   10  C4   first ledger line below
 *
 * Treble clef only, which is all the model has (ADR-0021).
 */

export const HALF_SPACE = STAFF_SPACE / 2;

/** Diatonic index: octave * 7 + step. Accidentals do not move a note on the staff. */
function diatonic(pitch: Pitch): number {
  return pitch.octave * 7 + STEPS.indexOf(pitch.step);
}

/** Treble clef: the top line is F5. */
const TOP_LINE_DIATONIC = diatonic({ step: 'F', alter: 0, octave: 5 });

export const TOP_LINE = 0;
export const MIDDLE_LINE = 4;
export const BOTTOM_LINE = 8;

/** Half spaces below the top line. Rises as the pitch falls, like page y. */
export function staffPosition(pitch: Pitch): number {
  return TOP_LINE_DIATONIC - diatonic(pitch);
}

/**
 * The pitch on each clef's top line (ADR-0041, slice 4): F5 treble, A3 bass, G4 alto, E4 tenor. Everything else about a
 * clef is this one number, because a position is only a distance from the top line. A percussion staff is unpitched, so
 * it has none; its notes all sit on the one line (`PERCUSSION_LINE`) until slice 6 maps a drum to a position.
 */
const CLEF_TOP_LINE: Record<Exclude<Clef, 'percussion'>, number> = {
  treble: TOP_LINE_DIATONIC,
  bass: diatonic({ step: 'A', alter: 0, octave: 3 }),
  alto: diatonic({ step: 'G', alter: 0, octave: 4 }),
  tenor: diatonic({ step: 'E', alter: 0, octave: 4 }),
};

/** The staff position of the one line of a one-line percussion staff: the middle line of the five. */
export const PERCUSSION_LINE = 4;

/** `staffPosition` against a given clef. Treble is `staffPosition` itself, so a lead sheet is untouched. */
export function staffPositionIn(pitch: Pitch, clef: Clef): number {
  if (clef === 'percussion') return PERCUSSION_LINE;
  return CLEF_TOP_LINE[clef] - diatonic(pitch);
}

/** How far a clef's top line sits from treble's, in staff positions: what a key signature shifts by (see signatures.ts). */
export function clefTopOffset(clef: Clef): number {
  if (clef === 'percussion') return 0;
  return CLEF_TOP_LINE[clef] - TOP_LINE_DIATONIC;
}

export function positionY(position: number, staveY: number): number {
  return staveY + position * HALF_SPACE;
}

export function pitchY(pitch: Pitch, staveY: number): number {
  return positionY(staffPosition(pitch), staveY);
}

/**
 * The ledger lines a note at this position needs, as staff positions.
 *
 * Ledger lines continue the staff's own line positions — every second half space —
 * outward as far as the note, so a note in the space beyond the last line still gets
 * that line. B5 (position -3) sits above A5's line and gets it; C6 (-4) gets A5's and
 * its own.
 */
export function ledgerPositions(position: number): number[] {
  const lines: number[] = [];
  for (let line = TOP_LINE - 2; line >= position; line -= 2) lines.push(line);
  for (let line = BOTTOM_LINE + 2; line <= position; line += 2) lines.push(line);
  return lines;
}

export interface StaffLinesSpec {
  x: number;
  width: number;
  staveY: number;
}

/**
 * The five lines. Centred on their positions rather than hanging below them, so the
 * staff's outer edges are symmetric about the notes.
 */
export function staffLines(font: MusicFont, spec: StaffLinesSpec, oneLine = false): SvgElement[] {
  const lines: SvgElement[] = [];
  // A percussion staff is a single line, the middle one (ADR-0041): the same box as a five-line staff, so the
  // systems stack unchanged and a barline or brace spans it like any other.
  for (let line = oneLine ? PERCUSSION_LINE : 0; line <= (oneLine ? PERCUSSION_LINE : BOTTOM_LINE); line += 2) {
    lines.push(
      el('rect', {
        class: 'se-stafflines',
        x: spec.x,
        y: positionY(line, spec.staveY) - font.ink.staffLine / 2,
        width: spec.width,
        height: font.ink.staffLine,
        fill: '#000000',
      }),
    );
  }
  return lines;
}

export interface LedgerLineSpec {
  /** Left edge of the notehead. */
  noteX: number;
  noteheadWidth: number;
  position: number;
  staveY: number;
}

export function ledgerLines(font: MusicFont, spec: LedgerLineSpec): SvgElement[] {
  return ledgerPositions(spec.position).map((line) =>
    el('rect', {
      class: 'se-ledgerline',
      x: spec.noteX - font.ink.ledgerExtension,
      y: positionY(line, spec.staveY) - font.ink.ledgerLine / 2,
      width: spec.noteheadWidth + font.ink.ledgerExtension * 2,
      height: font.ink.ledgerLine,
      fill: '#000000',
    }),
  );
}
