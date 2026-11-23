import type { LayoutVoice, NoteItem } from '@sibei/layout';
import { crossingFlips, writtenPitch } from '@sibei/layout';
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
  /** Notes whose numbered stem is reversed because their voice crosses another's at that onset (`stemFlips`). */
  flips?: ReadonlySet<Id>;
  /** Voice-3 notes merged onto voice 1's stems (`stemMerges`). */
  merges?: ReadonlyMap<Id, StemMerge>;
}

/**
 * Where two voices cross, the stems turn away from each other for that note (Gould; SIB2-233): the notes of a staff-bar
 * whose numbered direction is reversed. Empty on any staff-bar without a crossing, so nothing else moves.
 */
export function stemFlips(voices: readonly LayoutVoice[]): Set<Id> {
  const shifts = new Map<Id, 'up' | 'down'>();
  const input = voices.map((voice) => ({
    index: voice.index,
    notes: notesOf(voice).map((note) => {
      if (note.ottava !== undefined) shifts.set(note.noteId, note.ottava);
      return { id: note.noteId, onset: note.onset, pitch: note.pitch, duration: note.duration, tupletId: note.tupletId };
    }),
  }));
  return voicesWithMusic(voices) < 2 ? new Set() : crossingFlips(input, shifts);
}

/**
 * A voice-3 note that shares voice 1's stem (SIB2-233). Voices 1 and 3 both stem up, so where they strike the same
 * duration together they are one chord, not two stems side by side (Gould, ch. 4): one stem, from the lower head up past
 * the higher. `owns` is the head that draws that stem (the lower, voice 1's on a unison), `reach` the other head's
 * position, which the owner's stem must also clear, and `partner` the other note. Only an unbeamed quarter or half
 * outside a tuplet merges, since a beam would have to be shared too.
 */
export interface StemMerge {
  owns: boolean;
  partner: Id;
  /** The staff position of the other head, for the owner's stem to reach. */
  reach: number;
  /** The other head is the upper one of a second: it is the head that moves to the right of the stem. */
  displaced: boolean;
}

export function stemMerges(
  voices: readonly LayoutVoice[],
  clef: Clef,
  flips: ReadonlySet<Id>,
): Map<Id, StemMerge> {
  const merges = new Map<Id, StemMerge>();
  const first = voices.find((voice) => voice.index === 1);
  const third = voices.find((voice) => voice.index === 3);
  if (first === undefined || third === undefined || voicesWithMusic(voices) < 2) return merges;
  const mergeable = (note: NoteItem): boolean =>
    note.duration.value >= 2 && note.duration.value < 8 && note.tupletId === null && !flips.has(note.noteId) && note.tones === undefined;
  const positionOf = (note: NoteItem): number => staffPositionIn(writtenPitch(note.pitch, note.ottava), clef);
  for (const b of notesOf(third)) {
    const a = notesOf(first).find((note) => note.onset === b.onset);
    if (a === undefined || !mergeable(a) || !mergeable(b)) continue;
    if (a.duration.value !== b.duration.value || a.duration.dots !== b.duration.dots) continue;
    const pa = positionOf(a);
    const pb = positionOf(b);
    // Lower on the page is the larger position; voice 1 owns the stem of a unison.
    const aOwns = pa >= pb;
    const second = Math.abs(pa - pb) === 1;
    merges.set(a.noteId, { owns: aOwns, partner: b.noteId, reach: pb, displaced: second && !aOwns });
    merges.set(b.noteId, { owns: !aOwns, partner: a.noteId, reach: pa, displaced: second && aOwns });
  }
  return merges;
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
  const flips = context.flips ?? new Set<Id>();
  // A note's own direction: its voice's, or the reverse where the voices cross.
  const turned = (note: NoteItem, numbered: 'up' | 'down' | 'auto'): 'up' | 'down' | 'auto' =>
    numbered !== 'auto' && flips.has(note.noteId) ? (numbered === 'up' ? 'down' : 'up') : numbered;
  const positionOf = (note: NoteItem): number => staffPositionIn(writtenPitch(note.pitch, note.ottava), clef);
  // A stacked chord (SIB2-243) collides by any of its pitches, so each pitch is a position of its own.
  const positionsOf = (note: NoteItem): number[] => [
    positionOf(note),
    ...(note.tones ?? []).map((tone) => staffPositionIn(writtenPitch(tone.pitch, note.ottava), clef)),
  ];

  for (const note of notesOf(voice)) {
    const mine = turned(note, stemsOf(voice, voices));
    // One chord on one stem: the upper head of a second sits right of it, whichever voice it is in (`stemMerges`).
    const merge = context.merges?.get(note.noteId);
    let dx = merge?.displaced === true ? font.width(noteheadFor(note.duration)) : 0;
    for (const other of voices) {
      if (other.index >= voice.index || !hasMusic(other)) continue;
      for (const against of notesOf(other)) {
        if (against.onset !== note.onset) continue;
        // The partner of a merged chord is not a collision: it shares the stem.
        if (merge !== undefined && merge.partner === against.noteId) continue;
        const theirs = turned(against, stemsOf(other, voices));
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
