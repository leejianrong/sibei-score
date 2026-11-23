import type { LayoutVoice, NoteItem } from '@sibei/layout';
import { writtenPitch } from '@sibei/layout';
import type { Clef, Id } from '@sibei/model';
import type { MusicFont } from './font.js';
import { staffPositionIn } from './staff.js';
import { noteheadFor } from './stems.js';

/**
 * Where two voices on one staff give way to each other (ADR-0041, slice 4).
 *
 * A staff-bar with two or more voices that have music draws voice 1 and 3 stems up and 2 and 4 down, and the voices then
 * meet at every onset they share. Three things have to move, all of them conventions rather than metrics (Gould, ch. 4;
 * Sibelius does the same by default):
 *
 * - **Rests.** The upper voice's rests ride two half-spaces up and the lower voice's two down, so they sit clear of
 *   each other and of the other voice's notes. A whole-bar rest is offset like any other once there are two voices.
 * - **Noteheads a second or less apart.** Two heads on the same or the adjacent line or space cannot share a column,
 *   so the later voice's head moves to the other side of the stem: one notehead to the right. Where the two are the
 *   same head on the same line (a unison) they stay put and share it. A pair that has crossed (the lower voice above
 *   the upper) is treated like a second.
 * - **The accidental of a moved head** stays where the head would have been, so it clears both.
 *
 * Nothing here measures; a head's width is the font's advance for its glyph (ADR-0015).
 */

export interface VoiceShift {
  /** Units to move this note's notehead right. */
  dx: number;
  /** The x its accidental is drawn at, when the head moved. */
  accidentalX?: number;
}

export interface VoiceContext {
  /** The voice being engraved. */
  voice: LayoutVoice;
  /** Every voice of the staff-bar, this one included. */
  voices: readonly LayoutVoice[];
  clef: Clef;
}

function hasMusic(voice: LayoutVoice): boolean {
  return voice.items.some((item) => item.kind === 'note' || item.kind === 'rest');
}

/** How many of a staff-bar's voices carry music: the count that decides whether stems and rests part ways. */
export function voicesWithMusic(voices: readonly LayoutVoice[]): number {
  return voices.filter(hasMusic).length;
}

/** The stem direction a voice takes: by number when its staff-bar has two voices with music, otherwise automatic. */
export function stemsOf(voice: LayoutVoice, voices: readonly LayoutVoice[]): 'up' | 'down' | 'auto' {
  return voicesWithMusic(voices) < 2 ? 'auto' : voice.index % 2 === 1 ? 'up' : 'down';
}

/** How many half-spaces a rest of this voice is moved: up for an upper voice, down for a lower one, none alone. */
export function restShiftOf(voice: LayoutVoice, voices: readonly LayoutVoice[]): number {
  const stems = stemsOf(voice, voices);
  return stems === 'auto' ? 0 : stems === 'up' ? -2 : 2;
}

function notesOf(voice: LayoutVoice): NoteItem[] {
  return voice.items.filter((item): item is NoteItem => item.kind === 'note');
}

/**
 * The notehead moves of one voice's notes against the voices that rank above it (a lower index), keyed by note id.
 * Only the later of two colliding voices moves, so one pair is never moved twice.
 */
export function noteShifts(font: MusicFont, context: VoiceContext): Map<Id, VoiceShift> {
  const shifts = new Map<Id, VoiceShift>();
  const { voice, voices, clef } = context;
  if (voicesWithMusic(voices) < 2) return shifts;
  const mine = stemsOf(voice, voices);
  const positionOf = (note: NoteItem): number => staffPositionIn(writtenPitch(note.pitch, note.ottava), clef);
  // A stacked chord (SIB2-243) collides by any of its pitches, so each pitch is a position of its own.
  const positionsOf = (note: NoteItem): number[] => [
    positionOf(note),
    ...(note.tones ?? []).map((tone) => staffPositionIn(writtenPitch(tone.pitch, note.ottava), clef)),
  ];

  for (const note of notesOf(voice)) {
    let dx = 0;
    for (const other of voices) {
      if (other.index >= voice.index || !hasMusic(other)) continue;
      const theirs = stemsOf(other, voices);
      for (const against of notesOf(other)) {
        if (against.onset !== note.onset) continue;
        const width = font.width(noteheadFor(against.duration));
        for (const position of positionsOf(note)) {
          for (const there of positionsOf(against)) {
            let collides: boolean;
            if (theirs === mine) {
              // Two up voices (1 and 3) or two down: heads on one line or adjacent ones.
              collides = Math.abs(there - position) <= 1;
            } else {
              // Opposite stems: the down voice's head should sit lower. A unison or second, or a crossing, collides.
              const up = mine === 'up' ? position : there;
              const down = mine === 'up' ? there : position;
              collides = down - up <= 1;
            }
            // A unison of the same head shares it: nothing to move.
            const shared = there === position && noteheadFor(against.duration) === noteheadFor(note.duration);
            if (collides && !shared) dx = Math.max(dx, width);
          }
        }
      }
    }
    if (dx > 0) shifts.set(note.noteId, { dx });
  }
  return shifts;
}
