/**
 * The drum map (ADR-0041 slice 6): a drum instrument to where it is written on a five-line percussion staff.
 *
 * Pure data and lookups, plain TypeScript. A percussion note carries `Note.drum` (one of `DrumId`) and an optional
 * `Note.head`; its `pitch` is the **display pitch** the staff position comes from (`staffPosition`, treble
 * counting: the top line is F5), exactly what MusicXML's `<display-step>/<display-octave>` means for an unpitched
 * note. So everything that already turns a pitch into a line or space (layout's ink, the engraver, ledger lines)
 * works for drums unchanged; only the head glyph and the default voice are new.
 *
 * Conventions followed (the common drum-kit notation, as in MuseScore and Dorico's defaults):
 *
 *   A5  crash           x   ledger line above
 *   G5  hi-hat          x   above the top line   (open: circled x)
 *   F5  ride            x   top line            (bell: diamond)
 *   E5  high tom            top space
 *   D5  high-mid tom        second line         (clap: x, cowbell: diamond)
 *   C5  snare               third space         (side stick: x)
 *   B4  low-mid tom         middle line
 *   A4  low tom             second space from the bottom
 *   G4  high floor tom      second line from the bottom
 *   F4  kick                bottom space        stems down, voice 2
 *   E4  low floor tom       bottom line
 *   D4  pedal hi-hat        below the staff     x, stems down, voice 2
 *
 * Hands are voice 1 (stems up), feet voice 2 (stems down): the two-voice drum staff every drum chart uses. Positions
 * can coincide (two crashes, two floor toms share a place) because the *drum id* is what the model keeps; the
 * position is only where it is drawn.
 */

import { pitchToMidi } from './pitch.js';
import type { Pitch, Staff } from './score.js';

/** How a notehead is drawn. `normal` is the ordinary oval for the note's duration; the rest are percussion heads. */
export type NoteheadKind = 'normal' | 'x' | 'diamond' | 'circle-x';

export const NOTEHEAD_KINDS: readonly NoteheadKind[] = ['normal', 'x', 'diamond', 'circle-x'];

export function isNoteheadKind(value: unknown): value is NoteheadKind {
  return typeof value === 'string' && (NOTEHEAD_KINDS as readonly string[]).includes(value);
}

export type DrumId =
  | 'kick'
  | 'snare'
  | 'side-stick'
  | 'clap'
  | 'hihat'
  | 'hihat-open'
  | 'hihat-pedal'
  | 'ride'
  | 'ride-bell'
  | 'crash'
  | 'crash-2'
  | 'splash'
  | 'china'
  | 'tom-high'
  | 'tom-high-mid'
  | 'tom-low-mid'
  | 'tom-low'
  | 'floor-tom'
  | 'floor-tom-low'
  | 'cowbell'
  | 'tambourine'
  | 'percussion';

export interface DrumDef {
  id: DrumId;
  /** The name shown to a person (the text projection, the inspector). */
  label: string;
  /** The General MIDI percussion key (channel 10) this instrument plays: `<midi-unpitched>` in MusicXML. */
  gm: number;
  /** The display pitch: where it sits on the five lines (treble counting). */
  pitch: Pitch;
  head: NoteheadKind;
  /** 1 for the hands (stems up), 2 for the feet (stems down). */
  voice: 1 | 2;
  /** Extra names `parseDrum` accepts, normalised (lower case, no spaces, dashes or underscores). */
  aliases: readonly string[];
}

const p = (step: Pitch['step'], octave: number): Pitch => ({ step, alter: 0, octave });

const DEFS: readonly DrumDef[] = [
  { id: 'kick', label: 'Kick', gm: 36, pitch: p('F', 4), head: 'normal', voice: 2, aliases: ['bassdrum', 'bd', 'bassdrum1', 'acousticbassdrum'] },
  { id: 'snare', label: 'Snare', gm: 38, pitch: p('C', 5), head: 'normal', voice: 1, aliases: ['sd', 'acousticsnare', 'electricsnare', 'snaredrum'] },
  { id: 'side-stick', label: 'Side stick', gm: 37, pitch: p('C', 5), head: 'x', voice: 1, aliases: ['rimshot', 'rim', 'sidestick', 'crossstick'] },
  { id: 'clap', label: 'Hand clap', gm: 39, pitch: p('D', 5), head: 'x', voice: 1, aliases: ['handclap'] },
  { id: 'hihat', label: 'Hi-hat', gm: 42, pitch: p('G', 5), head: 'x', voice: 1, aliases: ['hh', 'hihatclosed', 'closedhihat', 'hat', 'closedhat', 'hhclosed', 'chh'] },
  { id: 'hihat-open', label: 'Open hi-hat', gm: 46, pitch: p('G', 5), head: 'circle-x', voice: 1, aliases: ['openhihat', 'hhopen', 'openhat', 'hihatopen', 'ohh'] },
  { id: 'hihat-pedal', label: 'Pedal hi-hat', gm: 44, pitch: p('D', 4), head: 'x', voice: 2, aliases: ['pedalhihat', 'hihatpedal', 'hhpedal', 'footchick'] },
  { id: 'ride', label: 'Ride', gm: 51, pitch: p('F', 5), head: 'x', voice: 1, aliases: ['ridecymbal', 'ridecymbal1', 'ridecymbal2'] },
  { id: 'ride-bell', label: 'Ride bell', gm: 53, pitch: p('F', 5), head: 'diamond', voice: 1, aliases: ['ridebell', 'bell'] },
  { id: 'crash', label: 'Crash', gm: 49, pitch: p('A', 5), head: 'x', voice: 1, aliases: ['crashcymbal', 'crashcymbal1', 'cc'] },
  { id: 'crash-2', label: 'Crash 2', gm: 57, pitch: p('A', 5), head: 'x', voice: 1, aliases: ['crashcymbal2', 'crash2'] },
  { id: 'splash', label: 'Splash', gm: 55, pitch: p('B', 5), head: 'x', voice: 1, aliases: ['splashcymbal'] },
  { id: 'china', label: 'China', gm: 52, pitch: p('C', 6), head: 'x', voice: 1, aliases: ['chinesecymbal', 'chinacymbal'] },
  { id: 'tom-high', label: 'High tom', gm: 50, pitch: p('E', 5), head: 'normal', voice: 1, aliases: ['hightom', 'tom1', 'hitom', 'tomhigh'] },
  { id: 'tom-high-mid', label: 'High-mid tom', gm: 48, pitch: p('D', 5), head: 'normal', voice: 1, aliases: ['highmidtom', 'tom2', 'hightom2'] },
  { id: 'tom-low-mid', label: 'Low-mid tom', gm: 47, pitch: p('B', 4), head: 'normal', voice: 1, aliases: ['lowmidtom', 'tom3', 'midtom', 'tom'] },
  { id: 'tom-low', label: 'Low tom', gm: 45, pitch: p('A', 4), head: 'normal', voice: 1, aliases: ['lowtom', 'tom4'] },
  { id: 'floor-tom', label: 'Floor tom', gm: 43, pitch: p('G', 4), head: 'normal', voice: 1, aliases: ['floortom', 'highfloortom', 'ft'] },
  { id: 'floor-tom-low', label: 'Low floor tom', gm: 41, pitch: p('E', 4), head: 'normal', voice: 1, aliases: ['lowfloortom', 'floortom2'] },
  { id: 'cowbell', label: 'Cowbell', gm: 56, pitch: p('D', 5), head: 'diamond', voice: 1, aliases: [] },
  { id: 'tambourine', label: 'Tambourine', gm: 54, pitch: p('E', 5), head: 'x', voice: 1, aliases: ['tamb'] },
  { id: 'percussion', label: 'Percussion', gm: 39, pitch: p('B', 4), head: 'x', voice: 1, aliases: ['perc', 'other', 'unknown'] },
];

export const DRUMS: readonly DrumDef[] = DEFS;

const BY_ID = new Map<string, DrumDef>(DEFS.map((d) => [d.id, d]));

export function isDrumId(value: unknown): value is DrumId {
  return typeof value === 'string' && BY_ID.has(value);
}

export function drumById(id: DrumId): DrumDef {
  return BY_ID.get(id)!;
}

/**
 * Other General MIDI keys onto the drum that stands for them. The primary key of each drum (`DrumDef.gm`) is the one
 * export writes; these are read-only synonyms.
 */
const GM_EXTRA: ReadonlyMap<number, DrumId> = new Map<number, DrumId>([
  [35, 'kick'],
  [40, 'snare'],
  [59, 'ride'],
  [60, 'tom-high'], // hi bongo
  [61, 'tom-high-mid'], // low bongo
  [62, 'tom-high'], // mute hi conga
  [63, 'tom-high-mid'], // open hi conga
  [64, 'tom-low'], // low conga
  [65, 'tom-high'], // high timbale
  [66, 'tom-high-mid'], // low timbale
  [67, 'cowbell'], // high agogo
  [68, 'cowbell'], // low agogo
]);

const BY_GM = new Map<number, DrumId>([...GM_EXTRA, ...DEFS.filter((d) => d.id !== 'percussion').map((d): [number, DrumId] => [d.gm, d.id])]);

/** The General MIDI percussion key range (35 to 81). Outside it a pitch is not a drum. */
export const GM_DRUM_LOW = 35;
export const GM_DRUM_HIGH = 81;

/** The drum a General MIDI key stands for, or null when the key is not in the map (the caller decides what it is). */
export function drumForGm(pitch: number): DrumId | null {
  return BY_GM.get(pitch) ?? null;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[\s_\-.]+/g, '');
}

const BY_NAME = new Map<string, DrumId>();
for (const d of DEFS) {
  BY_NAME.set(normalise(d.id), d.id);
  BY_NAME.set(normalise(d.label), d.id);
  for (const alias of d.aliases) BY_NAME.set(alias, d.id);
}

/** A drum named by a person or by NoteEvents' free-text `drum_class` (`kick`, `Hi-Hat`, `open_hihat`, `HH`). */
export function parseDrum(name: string): DrumId | null {
  return BY_NAME.get(normalise(name)) ?? null;
}

/**
 * The drum for a NoteEvents note: its `drum_class` when we recognise it (the transcriber's own label), else the
 * General MIDI key. `null` when neither says. A recognised class that disagrees with the key wins on purpose.
 */
export function drumOfNoteEvent(pitch: number, drumClass: string | null | undefined): DrumId | null {
  if (drumClass != null) {
    const named = parseDrum(drumClass);
    if (named !== null) return named;
  }
  return drumForGm(pitch);
}

/** The head a drum is drawn with unless the note overrides it. */
export function headOf(note: { drum?: DrumId; head?: NoteheadKind }): NoteheadKind {
  return note.head ?? (note.drum === undefined ? 'x' : drumById(note.drum).head);
}

/** Where a drum is written, as a pitch the staff-position code understands (a fresh copy, never shared). */
export function drumDisplayPitch(id: DrumId): Pitch {
  return { ...drumById(id).pitch };
}

/** The MIDI number of a drum's display pitch, for ordering in the inspector and for MusicXML's display step. */
export function drumDisplayMidi(id: DrumId): number {
  return pitchToMidi(drumById(id).pitch);
}

/**
 * Whether a staff is a drum kit, drawn on five lines with each drum at its own place, rather than the older
 * one-line percussion staff whose notes are one unspecified instrument. A derived fact, not stored: a percussion
 * staff is a kit as soon as any note on it names a drum, so an existing one-line staff draws exactly as before.
 */
export function isDrumKitStaff(staff: Staff): boolean {
  if (staff.type !== 'percussion') return false;
  return staff.bars.some((bar) =>
    bar.voices.some((voice) => voice.items.some((item) => item.kind === 'note' && item.drum !== undefined)),
  );
}
