import type { Alter, Bar, KeySignature, Note } from '@sibei/model';
import { keySignatureAccidentals } from '@sibei/model';

/**
 * Which accidental a note draws. Engine-independent notation logic, so it lives here
 * rather than in the draw adapter: any adapter would need the same answer.
 *
 * The rules are the conventional ones. The key signature sets the starting state; an
 * accidental is drawn only where a note departs from what the bar has established so
 * far; and the far end of a tie does not repeat it.
 */

export interface AccidentalState {
  resolve(note: Note): Alter | null;
}

function stateKey(note: Note): string {
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
      if (note.accidental === 'show') return note.pitch.alter;
      // The continuation of a tie carries the accidental of the note it came from.
      if (note.tie === 'stop' || note.tie === 'both') return null;
      return note.pitch.alter === established ? null : note.pitch.alter;
    },
  };
}

/** Accidentals for one bar, keyed by note id. */
export function resolveBarAccidentals(bar: Bar, key: KeySignature): Map<string, Alter | null> {
  const state = barAccidentalState(key);
  const result = new Map<string, Alter | null>();
  const ordered = [...bar.items].sort((a, b) => a.onset - b.onset);
  for (const item of ordered) {
    if (item.kind === 'note') result.set(item.id, state.resolve(item));
  }
  return result;
}
