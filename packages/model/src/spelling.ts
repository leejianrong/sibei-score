import { SEMITONE_OF_STEP, STEPS, pitchToMidi } from './pitch.js';
import type { Alter, KeySignature, Pitch, Step } from './score.js';

/**
 * The enharmonic spelling engine (ADR-0017), and the pitch arithmetic transposition (ADR-0016)
 * is built on. Pure, framework-free, Node-free — the same reason the rest of `model` is: this runs
 * in the browser and on the server, and both the `transpose` op and instrument-part rendering
 * reach it.
 *
 * The one question it answers: the same sounding pitch can be written `Bb` or `A#`, `Ab` or `G#`,
 * and something has to choose. ADR-0017's rule is **the destination key signature chooses**, with a
 * per-object pin as the escape hatch for the cases harmonic function argues against the key. In Eb
 * major the answer is `Bb` and `Ab`, never `A#`/`G#`; this module is where that becomes code.
 */

/** A pitch class written down: a step and its accidental, with no octave. A chord root is one too. */
export interface Spelling {
  step: Step;
  alter: Alter;
}

/**
 * A transposition, as the two numbers a spelled interval needs: how many *letter names* it moves
 * (`C -> E` is 2), and how many *semitones* it sounds (`C -> Eb` is 3). Both are needed because a
 * pinned spelling moves by the interval rather than being re-derived, and only the letter count can
 * say whether `F#` up a minor third is `A` or `Bbb` (ADR-0017).
 */
export interface Interval {
  letterSteps: number;
  semitones: number;
}

/**
 * The chromatic scale of a major key, as the number of letter names each of the twelve degrees sits
 * above the tonic. The default is flat-leaning — `b2 b3 b6 b7` — with `#4` the one raised degree,
 * which is the textbook ascending chromatic scale and, more to the point, never spells a flat-key
 * chromatic as a sharp: in Eb the tritone comes out `A` natural, not `A#`. Where function wants a
 * different spelling — a secondary dominant, a chromatic passing chord — the pin overrides it.
 *
 * Indexed by semitones above the tonic (0..11). The value is the letter offset; the accidental
 * falls out of making the pitch class come out right.
 */
const DEGREE_LETTER_OFFSET: readonly number[] = [0, 1, 1, 2, 2, 3, 3, 4, 5, 5, 6, 6];

function mod(value: number, m: number): number {
  return ((value % m) + m) % m;
}

/** The tonic's pitch class, 0..11. */
function tonicPitchClass(key: KeySignature): number {
  return mod(SEMITONE_OF_STEP[key.tonic] + key.alter, 12);
}

/**
 * The spelling the destination key signature gives a pitch class (ADR-0017). The letter comes from
 * the chromatic-degree table above; the accidental is whatever makes the letter land on the right
 * pitch class. The result stays within a double accidental for every one of the fifteen practical
 * major keys; `reletterIntoRange` keeps it total for the handful of nonsensical keys the type still
 * permits (a `C##` tonic), so nothing downstream has to guard against an out-of-range alter.
 */
export function spellPitchClass(pitchClass: number, key: KeySignature): Spelling {
  const pc = mod(pitchClass, 12);
  const degree = mod(pc - tonicPitchClass(key), 12);
  const letterOffset = DEGREE_LETTER_OFFSET[degree] ?? 0;
  const step = STEPS[mod(STEPS.indexOf(key.tonic) + letterOffset, 7)] as Step;
  return reletterIntoRange(step, pc);
}

/**
 * Spell a pitch given its MIDI number and a key. The pitch class is spelled by the key; the octave
 * is the one that makes the chosen spelling sound at that MIDI number, recovered by inverting
 * `pitchToMidi`. This is the unpinned transposition target: a note's new sounding pitch is known,
 * and the key decides how to write it down.
 */
export function spellPitchAt(midi: number, key: KeySignature): Pitch {
  const { step, alter } = spellPitchClass(midi, key);
  return { step, alter, octave: octaveFor(step, alter, midi) };
}

/**
 * The interval that carries the chart from one key to another (ADR-0016). The **nearest** one: the
 * semitone count is folded into `(-6, 6]` so `transpose --to A` from C moves down a minor third
 * rather than up a major sixth, keeping the melody near its register. The letter count follows the
 * same direction, so the two numbers describe one interval and not two.
 */
export function keyInterval(from: KeySignature, to: KeySignature): Interval {
  const rawSemitones = mod(tonicPitchClass(to) - tonicPitchClass(from), 12);
  const semitones = rawSemitones > 6 ? rawSemitones - 12 : rawSemitones;

  const letterDiff = mod(STEPS.indexOf(to.tonic) - STEPS.indexOf(from.tonic), 7);
  // A downward interval takes the downward letter count (`5` letters up is `2` down). At the unison
  // the letter count is 0; a plain octave never arises here because `to` and `from` are pitch
  // classes, not octaved pitches.
  const letterSteps = semitones < 0 && letterDiff !== 0 ? letterDiff - 7 : letterDiff;
  return { letterSteps, semitones };
}

/**
 * Transpose one melody note. An unpinned note is re-spelled from scratch in the destination key —
 * its new sounding pitch is `midi + semitones`, and `spellPitchAt` writes it the key's way. A
 * pinned note keeps the spelling it was given: the interval's letter count moves its letter and the
 * semitone count sets its accidental, so `F#` stays a raised note where the key would have re-spelled
 * it (ADR-0017). Either way the pin flag itself is the caller's to carry across.
 */
export function transposePitch(
  pitch: Pitch,
  interval: Interval,
  targetKey: KeySignature,
  pinned = false,
): Pitch {
  const targetMidi = pitchToMidi(pitch) + interval.semitones;
  if (!pinned) return spellPitchAt(targetMidi, targetKey);

  const letterAbs = STEPS.indexOf(pitch.step) + interval.letterSteps;
  const step = STEPS[mod(letterAbs, 7)] as Step;
  const octave = pitch.octave + Math.floor(letterAbs / 7);
  const alter = targetMidi - ((octave + 1) * 12 + SEMITONE_OF_STEP[step]);
  return { step, alter: alter as Alter, octave };
}

/**
 * Transpose a bare spelling — a chord root, or a slash bass — which is a pitch class with no octave.
 * Unpinned, the destination key re-spells it; pinned, the interval moves the letter and sets the
 * accidental, exactly as for a note but with the octave dropped.
 */
export function transposeSpelling(
  spelling: Spelling,
  interval: Interval,
  targetKey: KeySignature,
  pinned = false,
): Spelling {
  const fromPc = SEMITONE_OF_STEP[spelling.step] + spelling.alter;
  const targetPc = mod(fromPc + interval.semitones, 12);
  if (!pinned) return spellPitchClass(targetPc, targetKey);

  const step = STEPS[mod(STEPS.indexOf(spelling.step) + interval.letterSteps, 7)] as Step;
  return reletterIntoRange(step, targetPc);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The octave that makes `step`+`alter` sound at `midi`. `pitchToMidi` is
 * `(octave+1)*12 + semitone + alter`; since `semitone + alter` is congruent to `midi` mod 12, the
 * division is exact.
 */
function octaveFor(step: Step, alter: Alter, midi: number): number {
  return (midi - SEMITONE_OF_STEP[step] - alter) / 12 - 1;
}

/**
 * Give a chosen letter the accidental that lands it on `pitchClass`, keeping the result inside a
 * double accidental. For the fifteen practical keys the first accidental computed is already in
 * range; the re-lettering loop only ever runs for a nonsensical key the `KeySignature` type permits
 * but no transposition targets, and it exists so the engine is total rather than throwing there.
 * The starting letter is honoured (a pinned interval has already chosen it) unless honouring it
 * would need more than a double accidental.
 */
function reletterIntoRange(step: Step, pitchClass: number): Spelling {
  let index = STEPS.indexOf(step);
  for (let tries = 0; tries < 7; tries += 1) {
    const candidate = STEPS[mod(index, 7)] as Step;
    const alter = signedAlter(pitchClass - SEMITONE_OF_STEP[candidate]);
    if (alter >= -2 && alter <= 2) return { step: candidate, alter: alter as Alter };
    index += alter > 0 ? 1 : -1;
  }
  // Unreachable for any pitch class: some letter is always within a semitone or two of it.
  return { step, alter: 0 };
}

/** A semitone difference folded into `(-6, 6]`, so the nearest accidental is chosen. */
function signedAlter(difference: number): number {
  const d = mod(difference, 12);
  return d > 6 ? d - 12 : d;
}
