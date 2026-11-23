import type { Interval } from '@sibei/model';
import { intervalOfSemitones } from '@sibei/music';

/**
 * A part's transposition at the MusicXML edge (ADR-0041 slice 5a). The model keeps `Part.transposition` as
 * semitones from sounding to written pitch; MusicXML's `<transpose>` is the opposite way round (written to
 * sounding) and splits it into diatonic steps, chromatic semitones and octaves. These are the two conversions.
 *
 * Letter steps are not stored, so they are derived from the semitone count (`intervalOfSemitones`, in `music`,
 * which `writtenPart` shares). That is exact for every transposing instrument the app names.
 */

export { intervalOfSemitones };

/** The `<transpose>` values (written to sounding) for a part written `semitones` above its sounding pitch. */
export function transposeElementValues(semitones: number): { diatonic: number; chromatic: number; octaveChange: number } {
  const interval = intervalOfSemitones(semitones);
  const octaves = Math.trunc(semitones / 12);
  return {
    diatonic: -(interval.letterSteps - 7 * octaves),
    chromatic: -(semitones - 12 * octaves),
    octaveChange: -octaves,
  };
}

/** The inverse: the semitones from sounding to written, and the interval carrying written back down to concert. */
export function fromTransposeElement(values: {
  diatonic: number | null;
  chromatic: number;
  octaveChange: number;
}): { semitones: number; written: Interval } {
  const semitones = -(values.chromatic + 12 * values.octaveChange);
  const derived = intervalOfSemitones(semitones);
  const letterSteps =
    values.diatonic === null ? derived.letterSteps : -(values.diatonic + 7 * values.octaveChange);
  return { semitones, written: { letterSteps, semitones } };
}

/** The interval that undoes `written`: concert from written. */
export function inverse(interval: Interval): Interval {
  return { letterSteps: -interval.letterSteps, semitones: -interval.semitones };
}
