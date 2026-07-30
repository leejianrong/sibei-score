import type { Bar, Pitch } from '@sibei/model';
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

/** Treble clef: the top line is F5, the middle line B4, the bottom line E4. */
const TOP_LINE = diatonic({ step: 'F', alter: 0, octave: 5 });
const MIDDLE_LINE = diatonic({ step: 'B', alter: 0, octave: 4 });
const BOTTOM_LINE = diatonic({ step: 'E', alter: 0, octave: 4 });

/** One diatonic step is half a staff space. */
const STEP_UNITS = 5;

/** A stem runs about three and a half spaces from its notehead. */
const STEM_UNITS = 35;

/** Half a notehead, so the glyph's own extent is covered. */
const NOTEHEAD_UNITS = 5;

export interface SystemVertical {
  /** Units from the top of the system to the top staff line. */
  aboveStaff: number;
  /** Units from the bottom staff line to the bottom of the system. */
  belowStaff: number;
  /** Units above the top staff line where every chord symbol's baseline sits. */
  chordBaselineOffset: number;
  height: number;
}

export interface SystemVerticalInput {
  bars: Bar[];
  hasChords: boolean;
  hasRehearsalMark: boolean;
}

export function systemVertical(input: SystemVerticalInput, spec: PageSpec): SystemVertical {
  let inkAbove = 0;
  let inkBelow = 0;

  for (const bar of input.bars) {
    for (const item of bar.items) {
      if (item.kind !== 'note') continue;
      const index = diatonic(item.pitch);
      const stemUp = index < MIDDLE_LINE;
      const above = (index - TOP_LINE) * STEP_UNITS + NOTEHEAD_UNITS;
      const below = (BOTTOM_LINE - index) * STEP_UNITS + NOTEHEAD_UNITS;
      inkAbove = Math.max(inkAbove, above + (stemUp ? STEM_UNITS : 0));
      inkBelow = Math.max(inkBelow, below + (stemUp ? 0 : STEM_UNITS));
    }
  }

  inkAbove = Math.max(inkAbove, 0);
  inkBelow = Math.max(inkBelow, 0);

  const chordBaselineOffset = input.hasChords ? inkAbove + spec.chordClearance : 0;
  const chordBand = input.hasChords ? chordBaselineOffset + spec.chordAscent : inkAbove;
  const markBand = input.hasRehearsalMark ? chordBand + spec.rehearsalBand : chordBand;

  const aboveStaff = Math.max(spec.aboveStaff, markBand);
  const belowStaff = Math.max(spec.belowStaff, inkBelow);

  return {
    aboveStaff,
    belowStaff,
    chordBaselineOffset,
    height: aboveStaff + spec.staffHeight + belowStaff,
  };
}
