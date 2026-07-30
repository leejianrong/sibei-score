import type { Alter, KeySignature, Pitch, Step } from './score.js';

export const STEPS: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

const SEMITONE_OF_STEP: Record<Step, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** Semitones above C-1, so middle C (C4) is 60. Matches MIDI numbering. */
export function pitchToMidi(pitch: Pitch): number {
  return (pitch.octave + 1) * 12 + SEMITONE_OF_STEP[pitch.step] + pitch.alter;
}

const PITCH_PATTERN = /^([A-G])(#{1,2}|b{1,2})?(-?\d+)$/;

const ALTER_OF_ACCIDENTAL: Record<string, Alter> = { bb: -2, b: -1, '': 0, '#': 1, '##': 2 };

/**
 * Parse a compact pitch spec — `Eb5`, `F#4`, `C4` — into a Pitch. For fixtures,
 * tests and CLI input, not a wire format.
 */
export function parsePitch(spec: string): Pitch {
  const match = PITCH_PATTERN.exec(spec);
  if (match === null) throw new Error(`not a pitch: ${JSON.stringify(spec)}`);
  const [, step, accidental = '', octave] = match;
  const alter = ALTER_OF_ACCIDENTAL[accidental];
  if (step === undefined || octave === undefined || alter === undefined) {
    throw new Error(`not a pitch: ${JSON.stringify(spec)}`);
  }
  return { step: step as Step, alter, octave: Number(octave) };
}

export function formatAlter(alter: Alter): string {
  switch (alter) {
    case -2:
      return 'bb';
    case -1:
      return 'b';
    case 0:
      return '';
    case 1:
      return '#';
    case 2:
      return '##';
  }
}

export function formatPitch(pitch: Pitch): string {
  return `${pitch.step}${formatAlter(pitch.alter)}${pitch.octave}`;
}

export function formatKeySignature(key: KeySignature): string {
  return `${key.tonic}${formatAlter(key.alter)}${key.mode === 'minor' ? 'm' : ''}`;
}

/**
 * Position on the circle of fifths: positive counts sharps, negative flats. Zero is
 * C major or A minor. Used to decide which accidentals the key signature draws.
 */
export function keyFifths(key: KeySignature): number {
  const majorFifths: Record<Step, number> = { C: 0, D: 2, E: 4, F: -1, G: 1, A: 3, B: 5 };
  const base = majorFifths[key.tonic] + key.alter * 7;
  return key.mode === 'minor' ? base - 3 : base;
}

/** The steps the key signature alters, and by how much. */
export function keySignatureAccidentals(key: KeySignature): Map<Step, Alter> {
  const fifths = keyFifths(key);
  const sharpOrder: Step[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const flatOrder: Step[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
  const result = new Map<Step, Alter>();
  if (fifths > 0) {
    for (const step of sharpOrder.slice(0, Math.min(fifths, 7))) result.set(step, 1);
  } else if (fifths < 0) {
    for (const step of flatOrder.slice(0, Math.min(-fifths, 7))) result.set(step, -1);
  }
  return result;
}
