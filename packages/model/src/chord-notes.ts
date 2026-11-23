import { pitchToMidi } from './pitch.js';
import type { AccidentalDisplay, Id, Note, Pitch, StackedNote, TieRole } from './score.js';

/**
 * Stacked chords (ADR-0041 "As built: stacked chords", SIB2-243): the accessors every consumer uses so none of them
 * has to know that a chord is a `Note` carrying a `stack`. Plain TypeScript, no Node APIs.
 */

/** The most pitches one chord may hold: ten fingers. A write past it is refused; a stored one is read as it is. */
export const MAX_CHORD_TONES = 10;

/** One member of a chord as a consumer sees it, whether it is the carrying note or a `stack` entry. */
export interface ChordTone {
  id: Id;
  pitch: Pitch;
  accidental: AccidentalDisplay;
  tie: TieRole;
  spellingPinned: boolean;
  /** True for the carrying note itself (the one `note.rm`, slurs and tuplets address by `n3`). */
  primary: boolean;
}

/** Whether the note carries more than one pitch. */
export function isStackedChord(note: Note): boolean {
  return note.stack !== undefined && note.stack.length > 0;
}

/**
 * Every pitch of the chord, **lowest first** (ties broken by the order they were written). A lone note is a chord of
 * one, so a consumer that walks tones handles both with one loop and a single-note chart produces exactly what
 * it did before.
 */
export function chordTones(note: Note): ChordTone[] {
  const own: ChordTone = {
    id: note.id,
    pitch: note.pitch,
    accidental: note.accidental,
    tie: note.tie,
    spellingPinned: note.spellingPinned,
    primary: true,
  };
  if (!isStackedChord(note)) return [own];
  const all: ChordTone[] = [own, ...(note.stack ?? []).map((tone) => ({ ...tone, primary: false }))];
  return all
    .map((tone, order) => ({ tone, order }))
    .sort((a, b) => pitchToMidi(a.tone.pitch) - pitchToMidi(b.tone.pitch) || a.order - b.order)
    .map(({ tone }) => tone);
}

/** Whether two pitches are the same written pitch. A chord never holds the same one twice. */
export function samePitch(a: Pitch, b: Pitch): boolean {
  return a.step === b.step && a.alter === b.alter && a.octave === b.octave;
}

/** The chord's tone with this written pitch, or undefined. */
export function toneWithPitch(note: Note, pitch: Pitch): ChordTone | undefined {
  return chordTones(note).find((tone) => samePitch(tone.pitch, pitch));
}

/** Every id a note owns: its own, then its stack's. For id lookups and the id factory. */
export function noteIds(note: Note): Id[] {
  return [note.id, ...(note.stack ?? []).map((tone) => tone.id)];
}

/** A copy of the note with its pitches replaced by a mapper (transposition, spelling): every tone, primary included. */
export function mapTones(note: Note, move: (tone: ChordTone) => Pitch): Note {
  const next: Note = { ...note, pitch: move({ ...chordTones(note).find((t) => t.primary)! }) };
  if (note.stack !== undefined) {
    next.stack = note.stack.map((tone) => ({ ...tone, pitch: move({ ...tone, primary: false }) }));
  }
  return next;
}

/**
 * The note with `tone` removed. Removing the carrying note's own pitch promotes the lowest remaining stack member
 * into it (the item keeps its id, so slurs, tuplets and addresses survive; the promoted tone's own id retires).
 * Returns null when the tone is the only pitch left, which is the whole note going.
 */
export function withoutTone(note: Note, toneId: Id): Note | null {
  const stack = note.stack ?? [];
  if (toneId !== note.id) {
    const rest = stack.filter((tone) => tone.id !== toneId);
    const { stack: _drop, ...bare } = note;
    return rest.length === 0 ? bare : { ...bare, stack: rest };
  }
  if (stack.length === 0) return null;
  const order = [...stack].sort((a, b) => pitchToMidi(a.pitch) - pitchToMidi(b.pitch));
  const [promoted, ...rest] = order as [StackedNote, ...StackedNote[]];
  const { stack: _drop, ...bare } = note;
  const next: Note = {
    ...bare,
    pitch: promoted.pitch,
    accidental: promoted.accidental,
    tie: promoted.tie,
    spellingPinned: promoted.spellingPinned,
  };
  return rest.length === 0 ? next : { ...next, stack: rest };
}
