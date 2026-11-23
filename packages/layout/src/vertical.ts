import type { BarView, Clef, Id, OctaveShift, Pitch } from '@sibei/model';
import { STEPS } from '@sibei/model';
import type { PageSpec } from './page.js';

/**
 * How much vertical room a system needs, derived from the music in it.
 *
 * Two things depend on this. Notes reach above and below the staff, so a system
 * carrying a C6 and an E3 is taller than one that stays on the staff. And chord
 * symbols want a **common baseline**: a lead sheet reads as a line of harmony above a
 * line of melody, and a symbol nudged upward by the note beneath it breaks that line.
 *
 * VexFlow places a chord symbol at `min(the stave's top-text line, just above the
 * note)`, so it can be lifted by a tall note but never pushed down. Reserving room for
 * the tallest note in the system therefore makes the first term always win, and the
 * baseline comes out flat. Deciding how much room that is, is a layout decision, which
 * is why it is computed here and not in the adapter (ADR-0014).
 */

/** Diatonic index of a pitch: octave * 7 + step, ignoring accidentals. */
function diatonic(pitch: Pitch): number {
  return pitch.octave * 7 + STEPS.indexOf(pitch.step);
}

/** Treble clef's top line is F5 (the middle line is B4, the bottom E4; see `staffInk`). */
const TREBLE_TOP_LINE = diatonic({ step: 'F', alter: 0, octave: 5 });

/**
 * The top line of each pitched clef as a diatonic index (a staff's lines are a third apart, so the middle line is 4
 * below the top and the bottom 8). Treble is what every single-staff chart has always used; the others serve the
 * lower staves of a multi-staff system (SIB2-227). A percussion staff has no pitch, so no ink.
 */
const CLEF_TOP_LINE: Record<Exclude<Clef, 'percussion'>, number> = {
  treble: TREBLE_TOP_LINE,
  bass: diatonic({ step: 'A', alter: 0, octave: 3 }),
  alto: diatonic({ step: 'G', alter: 0, octave: 4 }),
  tenor: diatonic({ step: 'E', alter: 0, octave: 4 }),
};

/** One diatonic step is half a staff space. */
const STEP_UNITS = 5;

/** A stem runs about three and a half spaces from its notehead. */
const STEM_UNITS = 35;

/** Half a notehead, so the glyph's own extent is covered. */
const NOTEHEAD_UNITS = 5;

/**
 * Grace notes (SIB2-185) are drawn at this fraction of a normal note, with an up stem of `GRACE_STEM_UNITS`. The
 * engraver draws them by the same two numbers, so what layout reserves above the staff is what is drawn.
 */
export const GRACE_SCALE = 0.65;
export const GRACE_STEM_UNITS = 23;

/** An ottava line sits this far past the highest or lowest note ink, and takes this much room itself (SIB2-184). */
const OTTAVA_GAP = 15;
const OTTAVA_BAND = 6;

/**
 * A fermata's room above the top line (SIB2-183): its baseline sits at least `FERMATA_BASE` above the staff and
 * `FERMATA_GAP` above the note's head or stem, and the glyph is about `FERMATA_HEIGHT` tall. The engraver
 * places it by the same three numbers (`packages/engrave/src/marks.ts`), so what layout reserves is what is drawn.
 */
export const FERMATA_BASE = 15;
export const FERMATA_GAP = 10;
export const FERMATA_HEIGHT = 15;

/** Room one articulation mark takes beside a notehead: its glyph plus the gap (SIB2-179), shared with the engraver. */
export const ARTICULATION_BAND = 12;

export interface SystemVertical {
  /** Units from the top of the system to the top staff line. */
  aboveStaff: number;
  /** Units from the bottom staff line to the bottom of the system. */
  belowStaff: number;
  /** Units above the top staff line where every chord symbol's baseline sits. */
  chordBaselineOffset: number;
  /** Units above the top staff line of an 8va line (SIB2-184), when the system has one. */
  ottavaAboveOffset?: number;
  /** Units below the bottom staff line of an 8vb line, when the system has one. */
  ottavaBelowOffset?: number;
  height: number;
}

export interface SystemVerticalInput {
  bars: BarView[];
  hasChords: boolean;
  hasRehearsalMark: boolean;
  /** Notes drawn under an ottava line, so the ink is measured where it is drawn (SIB2-184). */
  shifts?: Map<Id, OctaveShift>;
  ottavaAbove?: boolean;
  ottavaBelow?: boolean;
  /** The clef of the staff the ink is measured against; absent is treble, as every chart has always been. */
  clef?: Clef;
}

export interface StaffInk {
  /** Units above the top staff line that the notes, stems, marks and fermatas reach. */
  inkAbove: number;
  /** Units below the bottom staff line. */
  inkBelow: number;
}

/**
 * The ink one staff's music puts above and below its five lines, in a given clef. `systemVertical` is this plus the
 * rows a system stacks above it; a multi-staff system asks it once per staff to place the staves (SIB2-227).
 */
export function staffInk(
  bars: readonly BarView[],
  shifts: Map<Id, OctaveShift> | undefined,
  clef: Clef = 'treble',
): StaffInk {
  if (clef === 'percussion') return { inkAbove: 0, inkBelow: 0 };
  const TOP_LINE = CLEF_TOP_LINE[clef];
  const MIDDLE_LINE = TOP_LINE - 4;
  const BOTTOM_LINE = TOP_LINE - 8;
  let inkAbove = 0;
  let inkBelow = 0;

  for (const bar of bars) {
    for (const item of bar.items) {
      // A fermata rides above the staff and above the note's own ink, so the chord band must clear it
      // (SIB2-183). A rest has no ink above the staff, so it sits at the fixed height.
      if (item.fermata === true && item.kind === 'rest') inkAbove = Math.max(inkAbove, FERMATA_BASE + FERMATA_HEIGHT);
      if (item.kind !== 'note') continue;
      const shift = shifts?.get(item.id);
      const index = diatonic(item.pitch) + (shift === undefined ? 0 : shift === 'up' ? -7 : 7);
      const stemUp = index < MIDDLE_LINE;
      const above = (index - TOP_LINE) * STEP_UNITS + NOTEHEAD_UNITS;
      const below = (BOTTOM_LINE - index) * STEP_UNITS + NOTEHEAD_UNITS;
      inkAbove = Math.max(inkAbove, above + (stemUp ? STEM_UNITS : 0));
      // Marks sit on the notehead side, away from the stem, and each takes a band of room (SIB2-179).
      if (item.articulations !== undefined && item.articulations.length > 0) {
        const room = ARTICULATION_BAND * item.articulations.length;
        if (stemUp) inkBelow = Math.max(inkBelow, below + room);
        else inkAbove = Math.max(inkAbove, above + room);
      }
      if (item.fermata === true) {
        const marks = (item.articulations?.length ?? 0) * ARTICULATION_BAND;
        const reach = above + (stemUp ? STEM_UNITS : marks);
        inkAbove = Math.max(inkAbove, Math.max(FERMATA_BASE, reach + FERMATA_GAP) + FERMATA_HEIGHT);
      }
      inkBelow = Math.max(inkBelow, below + (stemUp ? 0 : STEM_UNITS));
      // Grace notes are small with an up stem, so they add to the room above and below like a note of their own.
      for (const grace of item.graces ?? []) {
        const graceIndex = diatonic(grace.pitch) + (shift === undefined ? 0 : shift === 'up' ? -7 : 7);
        const graceAbove = (graceIndex - TOP_LINE) * STEP_UNITS + NOTEHEAD_UNITS * GRACE_SCALE + GRACE_STEM_UNITS;
        const graceBelow = (BOTTOM_LINE - graceIndex) * STEP_UNITS + NOTEHEAD_UNITS * GRACE_SCALE;
        inkAbove = Math.max(inkAbove, graceAbove);
        inkBelow = Math.max(inkBelow, graceBelow);
      }
    }
  }

  return { inkAbove: Math.max(inkAbove, 0), inkBelow: Math.max(inkBelow, 0) };
}

export function systemVertical(input: SystemVerticalInput, spec: PageSpec): SystemVertical {
  let { inkAbove, inkBelow } = staffInk(input.bars, input.shifts, input.clef);

  // An ottava line goes between the notes and everything above (or below) them, so the chord row rises with it.
  let ottavaAboveOffset: number | undefined;
  let ottavaBelowOffset: number | undefined;
  if (input.ottavaAbove === true) {
    ottavaAboveOffset = inkAbove + OTTAVA_GAP;
    inkAbove = ottavaAboveOffset + OTTAVA_BAND;
  }
  if (input.ottavaBelow === true) {
    ottavaBelowOffset = inkBelow + OTTAVA_GAP;
    inkBelow = ottavaBelowOffset + OTTAVA_BAND;
  }

  const chordBaselineOffset = input.hasChords ? inkAbove + spec.chordClearance : 0;
  const chordBand = input.hasChords ? chordBaselineOffset + spec.chordAscent : inkAbove;
  const markBand = input.hasRehearsalMark ? chordBand + spec.rehearsalBand : chordBand;

  const aboveStaff = Math.max(spec.aboveStaff, markBand);
  const belowStaff = Math.max(spec.belowStaff, inkBelow);

  return {
    aboveStaff,
    belowStaff,
    chordBaselineOffset,
    ...(ottavaAboveOffset === undefined ? {} : { ottavaAboveOffset }),
    ...(ottavaBelowOffset === undefined ? {} : { ottavaBelowOffset }),
    height: aboveStaff + spec.staffHeight + belowStaff,
  };
}
