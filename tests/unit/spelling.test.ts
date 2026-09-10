import {
  SEMITONE_OF_STEP,
  keyInterval,
  keySignatureAccidentals,
  pitchToMidi,
  spellPitchAt,
  spellPitchClass,
  transposePitch,
  transposeSpelling,
} from '@sibei/model';
import type { Alter, KeySignature, Pitch, Step } from '@sibei/model';
import { describe, expect, it } from 'vitest';

/**
 * The enharmonic spelling engine (ADR-0017). The rule under test is "the destination key signature
 * chooses the spelling, and a pin overrides it" — so the tests are organised as: every degree spells
 * to the right pitch class in every major key; the diatonic degrees agree with the key signature;
 * the flat-leaning default never puts a sharp where a flat key wants a flat; the interval between two
 * keys is the nearest one; and a pin survives transposition where the key would have re-spelled.
 */

/** The fifteen practical major keys, Cb through C#. */
const MAJOR_KEYS: { name: string; key: KeySignature }[] = [
  { name: 'Cb', key: { tonic: 'C', alter: -1, mode: 'major' } },
  { name: 'Gb', key: { tonic: 'G', alter: -1, mode: 'major' } },
  { name: 'Db', key: { tonic: 'D', alter: -1, mode: 'major' } },
  { name: 'Ab', key: { tonic: 'A', alter: -1, mode: 'major' } },
  { name: 'Eb', key: { tonic: 'E', alter: -1, mode: 'major' } },
  { name: 'Bb', key: { tonic: 'B', alter: -1, mode: 'major' } },
  { name: 'F', key: { tonic: 'F', alter: 0, mode: 'major' } },
  { name: 'C', key: { tonic: 'C', alter: 0, mode: 'major' } },
  { name: 'G', key: { tonic: 'G', alter: 0, mode: 'major' } },
  { name: 'D', key: { tonic: 'D', alter: 0, mode: 'major' } },
  { name: 'A', key: { tonic: 'A', alter: 0, mode: 'major' } },
  { name: 'E', key: { tonic: 'E', alter: 0, mode: 'major' } },
  { name: 'B', key: { tonic: 'B', alter: 0, mode: 'major' } },
  { name: 'F#', key: { tonic: 'F', alter: 1, mode: 'major' } },
  { name: 'C#', key: { tonic: 'C', alter: 1, mode: 'major' } },
];

const STEP_ORDER: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

function pitchClassOf(spelling: { step: Step; alter: Alter }): number {
  return (((SEMITONE_OF_STEP[spelling.step] + spelling.alter) % 12) + 12) % 12;
}

function spell(pc: number, key: KeySignature): string {
  const { step, alter } = spellPitchClass(pc, key);
  const glyph = alter === 0 ? '' : alter > 0 ? '#'.repeat(alter) : 'b'.repeat(-alter);
  return `${step}${glyph}`;
}

describe('spelling every degree in every major key', () => {
  it('always lands on the pitch class it was asked for', () => {
    for (const { name, key } of MAJOR_KEYS) {
      for (let pc = 0; pc < 12; pc += 1) {
        expect(pitchClassOf(spellPitchClass(pc, key)), `${name}, pc ${pc}`).toBe(pc);
      }
    }
  });

  it('never needs more than a double accidental', () => {
    for (const { name, key } of MAJOR_KEYS) {
      for (let pc = 0; pc < 12; pc += 1) {
        const { alter } = spellPitchClass(pc, key);
        expect(alter, `${name}, pc ${pc}`).toBeGreaterThanOrEqual(-2);
        expect(alter, `${name}, pc ${pc}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('spells the diatonic notes exactly as the key signature writes them', () => {
    // The seven diatonic degrees must use the seven distinct letters, each with the accidental the
    // key signature already declares — this is what ties the engine to `keySignatureAccidentals`
    // rather than being a second, drifting opinion about the key.
    for (const { name, key } of MAJOR_KEYS) {
      const sigAlter = keySignatureAccidentals(key);
      for (const step of STEP_ORDER) {
        const diatonicAlter = (sigAlter.get(step) ?? 0) as Alter;
        const pc = pitchClassOf({ step, alter: diatonicAlter });
        expect(spellPitchClass(pc, key), `${name}, letter ${step}`).toEqual({
          step,
          alter: diatonicAlter,
        });
      }
    }
  });
});

describe('the flat-leaning default (ADR-0017)', () => {
  it('spells the C major chromatic scale the textbook way', () => {
    const c = MAJOR_KEYS.find((k) => k.name === 'C')!.key;
    const scale = Array.from({ length: 12 }, (_, pc) => spell(pc, c));
    expect(scale).toEqual(['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']);
  });

  it('shows Bb and Ab in Eb, never A# or G# (the V6 demo)', () => {
    const eb = MAJOR_KEYS.find((k) => k.name === 'Eb')!.key;
    // The two pitch classes the demo watches: 10 is A#/Bb, 8 is G#/Ab.
    expect(spell(10, eb)).toBe('Bb');
    expect(spell(8, eb)).toBe('Ab');
    // And nothing in Eb is ever written as a raised A or G.
    for (let pc = 0; pc < 12; pc += 1) {
      const { step, alter } = spellPitchClass(pc, eb);
      expect((step === 'A' || step === 'G') && alter > 0, `Eb pc ${pc}`).toBe(false);
    }
  });

  it('raises the fourth in a sharp key', () => {
    const g = MAJOR_KEYS.find((k) => k.name === 'G')!.key;
    expect(spell(1, g)).toBe('C#'); // #4 of G is C#
    const d = MAJOR_KEYS.find((k) => k.name === 'D')!.key;
    expect(spell(8, d)).toBe('G#'); // #4 of D is G#
  });
});

describe('spellPitchAt puts the octave where the note sounds', () => {
  it('recovers a spelling whose MIDI number round-trips', () => {
    const eb = MAJOR_KEYS.find((k) => k.name === 'Eb')!.key;
    const pitch = spellPitchAt(63, eb); // Eb4
    expect(pitch).toEqual({ step: 'E', alter: -1, octave: 4 });
    expect(pitchToMidi(pitch)).toBe(63);
  });

  it('names the octave by the chosen letter, not the sounding one', () => {
    const eb = MAJOR_KEYS.find((k) => k.name === 'Eb')!.key;
    const pitch = spellPitchAt(83, eb); // sounds B5, written Cb in Eb
    expect(pitch).toEqual({ step: 'C', alter: -1, octave: 6 });
    expect(pitchToMidi(pitch)).toBe(83);
  });
});

describe('keyInterval is the nearest interval', () => {
  const key = (name: string): KeySignature => MAJOR_KEYS.find((k) => k.name === name)!.key;

  it('C to Eb is a minor third up', () => {
    expect(keyInterval(key('C'), key('Eb'))).toEqual({ letterSteps: 2, semitones: 3 });
  });

  it('C to A is a minor third down, not a major sixth up', () => {
    expect(keyInterval(key('C'), key('A'))).toEqual({ letterSteps: -2, semitones: -3 });
  });

  it('Bb to C is a major second up', () => {
    expect(keyInterval(key('Bb'), key('C'))).toEqual({ letterSteps: 1, semitones: 2 });
  });

  it('resolves the tritone upward', () => {
    expect(keyInterval(key('C'), key('F#'))).toEqual({ letterSteps: 3, semitones: 6 });
  });

  it('is a no-op between a key and itself', () => {
    expect(keyInterval(key('D'), key('D'))).toEqual({ letterSteps: 0, semitones: 0 });
  });
});

describe('transposition honours pins (ADR-0017)', () => {
  const c = { tonic: 'C', alter: 0, mode: 'major' } as const;
  const eb = { tonic: 'E', alter: -1, mode: 'major' } as const;
  const interval = keyInterval(c, eb); // { letterSteps: 2, semitones: 3 }

  it('re-spells an unpinned note by the destination key', () => {
    // A raised fifth in C (a G#, say from a secondary dominant) becomes the flat sixth of Eb when
    // the key is left to choose: Cb, not B.
    const gSharp: Pitch = { step: 'G', alter: 1, octave: 5 };
    expect(transposePitch(gSharp, interval, eb, false)).toEqual({ step: 'C', alter: -1, octave: 6 });
  });

  it('keeps a pinned note spelled by the interval, where the key would have re-spelled it', () => {
    const gSharp: Pitch = { step: 'G', alter: 1, octave: 5 };
    const moved = transposePitch(gSharp, interval, eb, true);
    expect(moved).toEqual({ step: 'B', alter: 0, octave: 5 });
    // Pinned and unpinned sound the same pitch; only the spelling differs.
    expect(pitchToMidi(moved)).toBe(pitchToMidi(transposePitch(gSharp, interval, eb, false)));
  });

  it('carries a pinned note across a letter wrap without losing the octave', () => {
    const b4: Pitch = { step: 'B', alter: 0, octave: 4 };
    expect(transposePitch(b4, interval, eb, true)).toEqual({ step: 'D', alter: 0, octave: 5 });
  });
});

describe('transposeSpelling moves a chord root', () => {
  const c = { tonic: 'C', alter: 0, mode: 'major' } as const;
  const eb = { tonic: 'E', alter: -1, mode: 'major' } as const;
  const interval = keyInterval(c, eb);

  it('re-spells an unpinned root by the destination key', () => {
    // C7 in concert C becomes Eb7 in Eb; a G root becomes Bb.
    expect(transposeSpelling({ step: 'C', alter: 0 }, interval, eb)).toEqual({ step: 'E', alter: -1 });
    expect(transposeSpelling({ step: 'G', alter: 0 }, interval, eb)).toEqual({ step: 'B', alter: -1 });
  });

  it('moves a slash bass the same way', () => {
    // The E of Ab/Eb-style figures: an A root and its own bass both ride the interval.
    expect(transposeSpelling({ step: 'A', alter: -1 }, interval, eb)).toEqual({ step: 'C', alter: -1 });
  });

  it('keeps a pinned root on the interval letter', () => {
    expect(transposeSpelling({ step: 'G', alter: 1 }, interval, eb, true)).toEqual({ step: 'B', alter: 0 });
  });
});
