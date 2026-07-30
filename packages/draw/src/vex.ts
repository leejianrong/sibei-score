import type { Alter, Duration, EndBarline, KeySignature, Pitch, StartBarline, TimeSignature } from '@sibei/model';
import { formatAlter } from '@sibei/model';
import { Barline, Fraction } from 'vexflow';

/**
 * Mapping from the model's vocabulary to VexFlow's. Pure translation: no decision
 * that layout has already made is revisited here (ADR-0014).
 */

/** VexFlow puts the first staff line this far below a stave's declared y. */
export const VEX_SPACE_ABOVE_STAFF_LN = 4;

export const VEX_STAFF_LINE_SPACING = 10;

export function vexKey(pitch: Pitch): string {
  return `${pitch.step.toLowerCase()}${formatAlter(pitch.alter)}/${pitch.octave}`;
}

export function vexAccidental(alter: Alter): string {
  switch (alter) {
    case -2:
      return 'bb';
    case -1:
      return 'b';
    case 0:
      return 'n';
    case 1:
      return '#';
    case 2:
      return '##';
  }
}

const DURATION_CODE: Record<number, string> = {
  1: 'w',
  2: 'h',
  4: 'q',
  8: '8',
  16: '16',
  32: '32',
};

export function vexDuration(duration: Duration): string {
  const code = DURATION_CODE[duration.value];
  if (code === undefined) throw new Error(`unsupported note value: ${duration.value}`);
  return code;
}

/**
 * Where a rest sits vertically. VexFlow reads this from the key, and the conventional
 * positions differ for a whole rest, which hangs from the fourth line.
 */
export function vexRestKey(duration: Duration): string {
  return duration.value === 1 ? 'd/5' : 'b/4';
}

export function vexKeySignature(key: KeySignature): string {
  return `${key.tonic}${formatAlter(key.alter)}${key.mode === 'minor' ? 'm' : ''}`;
}

export function vexTimeSignature(time: TimeSignature): string {
  return `${time.beats}/${time.beatValue}`;
}

export function vexStartBarline(barline: StartBarline): number {
  switch (barline) {
    case 'none':
      return Barline.type.NONE;
    case 'repeat-start':
      return Barline.type.REPEAT_BEGIN;
  }
}

export function vexEndBarline(barline: EndBarline): number {
  switch (barline) {
    case 'single':
      return Barline.type.SINGLE;
    case 'double':
      return Barline.type.DOUBLE;
    case 'final':
      return Barline.type.END;
    case 'repeat-end':
      return Barline.type.REPEAT_END;
  }
}

/**
 * Beam groups: one group per beat, or per dotted beat in a compound meter. VexFlow
 * does the grouping and the slope; this only says what a group is.
 */
export function vexBeamGroups(time: TimeSignature): Fraction[] {
  const compound = time.beatValue === 8 && time.beats % 3 === 0;
  return compound ? [new Fraction(3, 8)] : [new Fraction(1, time.beatValue)];
}
