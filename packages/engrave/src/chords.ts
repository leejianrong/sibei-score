import type { Alter, AccidentalDisplay } from '@sibei/model';
import type { MusicFont } from './font.js';
import { ACCIDENTAL_GAP, accidentalGlyph, parensWidth } from './spacing.js';

/**
 * The geometry of a stacked chord (SIB2-243, ADR-0041 "As built: stacked chords"): which heads sit on the far side of the
 * stem, and where each accidental goes. Pure functions of staff positions (half spaces below the top line, so a larger
 * number is lower), kept apart from `engrave.ts` so the rules can be asserted rather than only looked at.
 *
 * Gould's rules, in the forms used here:
 * - heads a second (or a unison) apart cannot share a side of the stem, so the one met second, walking from the stem's
 *   attached end, moves to the other side; the next head is then free to take the stem side again;
 * - accidentals are set in columns left of the whole chord, the one nearest the head first; an accidental takes the
 *   nearest column where it is at least a seventh (six half spaces) clear of the accidentals already there.
 */

/** One head of a chord. `alter` is the accidental to draw (already resolved against key and bar), or null. */
export interface ChordHead {
  position: number;
  alter: Alter | null;
  display: AccidentalDisplay;
}

/**
 * Which column each head (in the order given) takes across the stem: 0 is the stem's own side, 1 the far side, 2 one head
 * further out. Walking from the stem's attached end, a head takes the first column where no head within a second (or a
 * unison) already sits. A second or a unison needs two columns; a unison-plus-second cluster such as F, F#, G needs
 * three, since the G is a second from both the F and the F# (SIB2-253).
 */
export function headColumns(positions: readonly number[], direction: 'up' | 'down'): number[] {
  const order = positions
    .map((position, index) => ({ position, index }))
    // Walk from the stem's attached end: the lowest head for an up stem, the highest for a down one.
    .sort((a, b) => (direction === 'up' ? b.position - a.position : a.position - b.position) || a.index - b.index);
  const columns = positions.map(() => 0);
  const taken: number[][] = [];
  for (const { position, index } of order) {
    let column = 0;
    while (taken[column]?.some((other) => Math.abs(other - position) <= 1) === true) column += 1;
    (taken[column] ??= []).push(position);
    columns[index] = column;
  }
  return columns;
}

/** Whether each head sits off the stem's own side (`headColumns` above zero). */
export function displacedHeads(positions: readonly number[], direction: 'up' | 'down'): boolean[] {
  return headColumns(positions, direction).map((column) => column > 0);
}

/** A column index (0 nearest the heads) for each head's accidental, or null where it draws none. */
export function accidentalColumns(heads: readonly ChordHead[]): (number | null)[] {
  const columns: (number | null)[] = heads.map(() => null);
  const placed: number[][] = [];
  const order = heads
    .map((head, index) => ({ head, index }))
    .filter(({ head }) => head.alter !== null)
    .sort((a, b) => a.head.position - b.head.position || a.index - b.index);
  for (const { head, index } of order) {
    let column = 0;
    while (placed[column]?.some((position) => Math.abs(position - head.position) < 6) === true) column += 1;
    (placed[column] ??= []).push(head.position);
    columns[index] = column;
  }
  return columns;
}

/** How wide one accidental draws, parentheses included. */
function widthOf(font: MusicFont, alter: Alter, display: AccidentalDisplay): number {
  return font.width(accidentalGlyph(alter)) + (display === 'parens' ? parensWidth(font) : 0);
}

/** Each column as wide as its widest accidental. */
function columnWidths(font: MusicFont, heads: readonly ChordHead[], columns: readonly (number | null)[]): number[] {
  const widths: number[] = [];
  columns.forEach((column, index) => {
    const head = heads[index];
    if (column === null || head === undefined || head.alter === null) return;
    widths[column] = Math.max(widths[column] ?? 0, widthOf(font, head.alter, head.display));
  });
  return widths;
}

/**
 * The room a chord's accidental columns need left of its heads: each column as wide as its widest accidental plus a
 * gap. Zero when nothing draws one.
 */
export function accidentalRoom(font: MusicFont, heads: readonly ChordHead[]): number {
  const widths = columnWidths(font, heads, accidentalColumns(heads));
  return widths.reduce((sum, width) => sum + (width ?? 0) + ACCIDENTAL_GAP, 0);
}

/** The right edge of each head's accidental, given the left edge of the chord's heads. Null where none is drawn. */
export function accidentalRights(font: MusicFont, heads: readonly ChordHead[], left: number): (number | null)[] {
  const columns = accidentalColumns(heads);
  const widths = columnWidths(font, heads, columns);
  const rights: number[] = [];
  let edge = left;
  widths.forEach((width, column) => {
    rights[column] = edge - ACCIDENTAL_GAP;
    edge = (rights[column] ?? edge) - (width ?? 0);
  });
  return columns.map((column) => (column === null ? null : (rights[column] ?? null)));
}
