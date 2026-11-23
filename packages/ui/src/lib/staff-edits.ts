import { STEPS, allStaves, parsePitch, pitchToMidi, voiceHoldsNotation, voiceIndexes } from '@sibei/model';
import type { Clef, Score, StaffType } from '@sibei/model';
import type { Duration } from '@sibei/model';
import type { Operation } from './api.js';
import type { Lane } from './lanes.js';

/**
 * The staves-and-voices panel's logic (ADR-0041, slice 5b), kept pure so a unit test can pin it. The ops it
 * builds are the ones slice 2 gave the applier (`part.add|rm`, `staff.add|rm`, `voice.add|rm`, `clef.set`,
 * `instrument.set`) and the CLI verbs of the same names; nothing here is a second write path.
 *
 * Parts, staves and voices are addressed the way the CLI does: `p2`, `s3`, `s3.v2`, counted across the score in
 * order. A removal of something that holds notation is not sent without `force`, and the panel asks first.
 */

export const CLEFS: readonly Clef[] = ['treble', 'bass', 'alto', 'tenor', 'percussion'];
export const STAFF_TYPES: readonly StaffType[] = ['standard', 'percussion', 'tab'];
export const VOICE_NUMBERS: readonly number[] = [1, 2, 3, 4];

export interface VoiceRow {
  index: number;
  /** A note, a rest or a tuplet is in it somewhere in the chart. */
  holdsNotation: boolean;
}

export interface StaffRow {
  /** Counted across the score from 1: `s2`. */
  number: number;
  id: string;
  clef: Clef;
  type: StaffType;
  voices: VoiceRow[];
  holdsNotation: boolean;
}

export interface PartRow {
  /** Counted from 1: `p2`. */
  number: number;
  id: string;
  name: string;
  instrument: number | null;
  transposition: number;
  staves: StaffRow[];
  holdsNotation: boolean;
}

/** The parts of the chart, each with its staves and voices, numbered the way the address grammar numbers them. */
export function partRows(score: Score): PartRow[] {
  const staffNumbers = new Map(allStaves(score).map((staff, at) => [staff.id, at + 1] as const));
  return score.parts.map((part, at): PartRow => {
    const staves = part.staves.map((staff): StaffRow => {
      const voices = voiceIndexes(staff).map((index): VoiceRow => ({ index, holdsNotation: voiceHoldsNotation(staff, index) }));
      return {
        number: staffNumbers.get(staff.id) ?? 0,
        id: staff.id,
        clef: staff.clef,
        type: staff.type,
        voices,
        holdsNotation: voices.some((voice) => voice.holdsNotation),
      };
    });
    return {
      number: at + 1,
      id: part.id,
      name: part.name,
      instrument: part.instrument,
      transposition: part.transposition,
      staves,
      holdsNotation: staves.some((staff) => staff.holdsNotation),
    };
  });
}

/** A removal that must be refused while it holds music: with `force` once the reader has confirmed. */
function withForce(force: boolean): { payload: { force: true } } | Record<string, never> {
  return force ? { payload: { force: true } } : {};
}

export function addPartOp(name: string, clef: Clef, staffType: StaffType): Operation {
  const payload: { name?: string; clef: Clef; staffType: StaffType } = { clef, staffType };
  if (name.trim() !== '') payload.name = name.trim();
  return { type: 'part.add', payload };
}

export function removePartOp(part: PartRow, force: boolean): Operation {
  return { type: 'part.rm', target: `p${part.number}`, ...withForce(force) };
}

export function addStaffOp(part: PartRow, clef: Clef, staffType: StaffType): Operation {
  return { type: 'staff.add', target: `p${part.number}`, payload: { clef, type: staffType } };
}

export function removeStaffOp(staff: StaffRow, force: boolean): Operation {
  return { type: 'staff.rm', target: `s${staff.number}`, ...withForce(force) };
}

export function addVoiceOp(staff: StaffRow): Operation {
  return { type: 'voice.add', target: `s${staff.number}` };
}

export function removeVoiceOp(staff: StaffRow, voice: number, force: boolean): Operation {
  return { type: 'voice.rm', target: `s${staff.number}.v${voice}`, ...withForce(force) };
}

/** Re-home one note, chord or pitch of a chord (`s1.bar3.beat2.E4`) on another staff, `s2` or `s2.v1` (SIB2-244). */
export function moveNoteOp(target: string, to: string): Operation {
  return { type: 'note.move', target, payload: { to } };
}

/** What the Staves panel's range form holds. Blank bar fields are not a range; a pitch limit is `below` or `above`, or neither. */
export interface HandMoveEdits {
  first: string;
  last: string;
  from: number;
  to: number;
  limit: 'all' | 'below' | 'above';
  pitch: string;
}

export interface HandMoveParse {
  ok: boolean;
  error: string | null;
  op: Operation | null;
}

/** The `hand.move` for the range form, or the first reason it cannot be sent (the server judges everything else). */
export function handMoveOp(edits: HandMoveEdits): HandMoveParse {
  const first = Number(edits.first.trim());
  const last = Number(edits.last.trim());
  if (edits.first.trim() === '' || !Number.isInteger(first) || edits.last.trim() === '' || !Number.isInteger(last)) {
    return { ok: false, error: 'Name the first and the last bar, as whole numbers.', op: null };
  }
  if (first > last) return { ok: false, error: 'The range runs backwards: the first bar comes before the last.', op: null };
  if (edits.from === edits.to) return { ok: false, error: 'Pick two different staves.', op: null };
  const payload: { from: string; to: string; first: number; last: number; below?: string; above?: string } = {
    from: `s${edits.from}`,
    to: `s${edits.to}`,
    first,
    last,
  };
  if (edits.limit !== 'all') {
    const pitch = edits.pitch.trim();
    try {
      parsePitch(pitch);
    } catch {
      return { ok: false, error: `${JSON.stringify(pitch)} is not a pitch — try C4 or Bb3.`, op: null };
    }
    payload[edits.limit] = pitch;
  }
  return { ok: true, error: null, op: { type: 'hand.move', payload } };
}

/** A staff's opening clef (`s2`), or the change that starts at a bar (`s2.bar5`); `null` clears a change. */
export function setClefOp(staff: StaffRow, clef: Clef | null, barNumber?: number): Operation {
  const target = barNumber === undefined ? `s${staff.number}` : `s${staff.number}.bar${barNumber}`;
  return { type: 'clef.set', target, payload: { clef } };
}

/** What a part's name, General MIDI program and transposition become; only the fields that changed are sent. */
export interface InstrumentEdits {
  name: string;
  /** Blank is no program (`null`). */
  program: string;
  /** Whole semitones, blank is 0. */
  transposition: string;
}

export interface InstrumentParse {
  ok: boolean;
  error: string | null;
  op: Operation | null;
}

/** The `instrument.set` for a part's edited fields, or the first reason the fields cannot be sent. */
export function instrumentOp(part: PartRow, edits: InstrumentEdits): InstrumentParse {
  const payload: { name?: string; instrument?: number | null; transposition?: number } = {};
  const name = edits.name.trim();
  if (name !== part.name) payload.name = name;

  const programText = edits.program.trim();
  let program: number | null = null;
  if (programText !== '') {
    program = Number(programText);
    if (!Number.isInteger(program) || program < 0 || program > 127) {
      return { ok: false, error: 'A General MIDI program is a whole number from 0 to 127, or blank for none.', op: null };
    }
  }
  if (program !== part.instrument) payload.instrument = program;

  const shiftText = edits.transposition.trim();
  const shift = shiftText === '' ? 0 : Number(shiftText);
  if (!Number.isInteger(shift) || shift < -48 || shift > 48) {
    return { ok: false, error: 'A transposition is whole semitones from -48 to 48.', op: null };
  }
  if (shift !== part.transposition) payload.transposition = shift;

  if (Object.keys(payload).length === 0) return { ok: true, error: null, op: null };
  return { ok: true, error: null, op: { type: 'instrument.set', target: `p${part.number}`, payload } };
}

/** A pitch that sits in the middle of the staff for a clef, to seed the add-a-note field. */
export function seedPitchFor(clef: Clef): string {
  switch (clef) {
    case 'bass':
      return 'D3';
    case 'alto':
      return 'C4';
    case 'tenor':
      return 'A3';
    case 'percussion':
      return 'C5';
    case 'treble':
      return 'B4';
  }
}

export interface NewItem {
  kind: 'note' | 'rest';
  /** 1-based, fractional between beats (`2.5`). */
  beat: number;
  pitch: string;
  duration: Duration;
}

/**
 * The op that puts a note or a rest at a beat of a bar in the active lane. The address carries the staff and
 * voice qualifier when the chart needs one (`s2.v2.bar3.beat1`), so it can never land on the first lane by default.
 */
export function newItemOp(qualifier: string, barNumber: number, item: NewItem): Operation {
  const target = `${qualifier}bar${barNumber}.beat${item.beat}`;
  return item.kind === 'note'
    ? { type: 'note.add', target, payload: { pitch: item.pitch, duration: item.duration } }
    : { type: 'rest.add', target, payload: { duration: item.duration } };
}

/**
 * The natural pitch a third above (`1`) or below (`-1`) one, for the chord inspector's Add above / Add below
 * (SIB2-243): C4 gives E4 above and A3 below. A diatonic step count, so the caller may spell it differently after.
 */
export function thirdFrom(pitch: string, direction: 1 | -1): string {
  const parsed = parsePitch(pitch);
  const index = parsed.octave * 7 + STEPS.indexOf(parsed.step) + 2 * direction;
  const octave = Math.floor(index / 7);
  return `${STEPS[index - octave * 7]}${octave}`;
}

/** `bar3.beat2.E4`: one pitch of the chord at a position, the address `note rm` and `note set` take (SIB2-243). */
export function chordToneAddress(qualifier: string, barNumber: number, beat: number, pitch: string): string {
  return `${qualifier}bar${barNumber}.beat${beat}.${pitch}`;
}

/** Which voice the key `1` to `4` selects on the active staff, or null when the staff has no such voice. */
export function voiceForKey(score: Score, lane: Lane, key: string): number | null {
  if (!/^[1-4]$/.test(key)) return null;
  const staff = allStaves(score)[lane.staff - 1];
  if (staff === undefined) return null;
  const voice = Number(key);
  return voiceIndexes(staff).includes(voice) ? voice : null;
}

/** A split point typed as a MIDI number (`60`) or a pitch (`C4`), or null when it is neither (SIB2-244). The server judges the range. */
export function splitPointOf(text: string): number | null {
  const raw = text.trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  try {
    return pitchToMidi(parsePitch(raw));
  } catch {
    return null;
  }
}
