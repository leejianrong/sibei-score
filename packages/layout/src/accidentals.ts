import type { AccidentalDisplay, Alter, BarView, KeySignature, Pitch, TieRole } from '@sibei/model';
import { chordTones } from '@sibei/model';
import { keySignatureAccidentals } from '@sibei/model';

/**
 * Which accidental a note draws. Engine-independent notation logic, so it lives here
 * rather than in the draw adapter: any adapter would need the same answer.
 *
 * The rules are the conventional ones. The key signature sets the starting state; an
 * accidental is drawn only where a note departs from what the bar has established so
 * far; and the far end of a tie does not repeat it.
 */

/** What an accidental depends on: a note, or one pitch of a stacked chord. */
export interface Pitched {
  pitch: Pitch;
  accidental: AccidentalDisplay;
  tie: TieRole;
}

export interface AccidentalState {
  resolve(note: Pitched): Alter | null;
}

function stateKey(note: Pitched): string {
  return `${note.pitch.step}${note.pitch.octave}`;
}

/** Accidental state is per bar: it resets at every barline. */
export function barAccidentalState(key: KeySignature): AccidentalState {
  const fromKey = keySignatureAccidentals(key);
  const seen = new Map<string, Alter>();

  return {
    resolve(note) {
      const established = seen.get(stateKey(note)) ?? fromKey.get(note.pitch.step) ?? 0;
      seen.set(stateKey(note), note.pitch.alter);

      if (note.accidental === 'hide') return null;
      if (note.accidental === 'show' || note.accidental === 'parens') return note.pitch.alter;
      // The continuation of a tie carries the accidental of the note it came from.
      if (note.tie === 'stop' || note.tie === 'both') return null;
      return note.pitch.alter === established ? null : note.pitch.alter;
    },
  };
}

/**
 * Accidentals for one bar, keyed by note id — and, for a stacked chord, by each of its pitches' own ids too, resolved
 * low to high so that the same line or space inside one chord is spoken once (SIB2-243).
 */
export function resolveBarAccidentals(bar: BarView, key: KeySignature): Map<string, Alter | null> {
  const state = barAccidentalState(key);
  const result = new Map<string, Alter | null>();
  const ordered = [...bar.items].sort((a, b) => a.onset - b.onset);
  for (const item of ordered) {
    if (item.kind !== 'note') continue;
    if (item.stack === undefined || item.stack.length === 0) {
      result.set(item.id, state.resolve(item));
      continue;
    }
    for (const tone of chordTones(item)) result.set(tone.id, state.resolve(tone));
  }
  return result;
}

/**
 * Accidentals for one note's grace notes, in order (SIB2-185). A grace draws an accidental where it departs from the
 * key signature or from an earlier grace on the same line or space of the same group. It does not read the bar's
 * state and does not change it: the principal note resolves its own accidental as if the graces were not there, so
 * a grace sharp before a sharp principal draws both, which is the safe reading.
 */
export function graceAccidentals(note: import('@sibei/model').Note, key: KeySignature): (Alter | null)[] {
  const fromKey = keySignatureAccidentals(key);
  const seen = new Map<string, Alter>();
  return (note.graces ?? []).map((grace) => {
    const at = `${grace.pitch.step}${grace.pitch.octave}`;
    const established = seen.get(at) ?? fromKey.get(grace.pitch.step) ?? 0;
    seen.set(at, grace.pitch.alter);
    if (grace.accidental === 'hide') return null;
    if (grace.accidental === 'show' || grace.accidental === 'parens') return grace.pitch.alter;
    return grace.pitch.alter === established ? null : grace.pitch.alter;
  });
}
