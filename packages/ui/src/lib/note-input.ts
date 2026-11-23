import {
  STEPS,
  allStaves,
  barCapacity,
  barView,
  chordTones,
  durationTicks,
  formatBeat,
  formatPitch,
  itemTicks,
  keySignatureAccidentals,
  makeNote,
  mapBarView,
  onsetOfBeat,
  beatOfOnset,
  voiceIndexes,
} from '@sibei/model';
import type {
  Alter,
  Clef,
  Dots,
  Duration,
  Id,
  KeySignature,
  NoteValue,
  Pitch,
  Score,
  Step,
  TieRole,
  TimeSignature,
} from '@sibei/model';
import type { Operation } from './api.js';
import type { Lane } from './lanes.js';
import { qualifierOf } from './lanes.js';
import { seedPitchFor } from './staff-edits.js';

/**
 * Keyboard note input, the pure half (SIB2-155).
 *
 * A **caret** (a lane, a bar, an onset) says where the next note goes; a **step** takes the state, one
 * key's action and a read-only view of the score, and answers the next state plus the **ordinary ops** that
 * make the edit (`note.add`, `rest.add`, `note.rm`, `note.set`, `bar.add`): nothing here is a second write path
 * and nothing is drawn here — the browser previews the note at the caret by rendering a copy of the score through
 * the one layout + engrave path (`ghostScore`).
 *
 * The state holds no history. What "the previous note" is (for Backspace, the arrow keys, a tie or an accidental
 * pressed after a note) is always read from the score, as the item that **ends exactly at the caret**, so the
 * caret and the document cannot drift apart; the caller runs each step only after the last one's ops have landed
 * and the score has been re-read, which is what makes typing ahead of the server safe.
 *
 * Key map (documented on screen and in the `?` overlay; Sibelius's keypad numbering, which suits a QWERTY row):
 * digits are durations *inside the mode only* (outside it they still pick a voice), `1` 32nd … `6` whole.
 */

export const DURATION_KEYS: ReadonlyArray<{ key: string; value: NoteValue; label: string }> = [
  { key: '1', value: 32, label: '32nd' },
  { key: '2', value: 16, label: '16th' },
  { key: '3', value: 8, label: '8th' },
  { key: '4', value: 4, label: 'Quarter' },
  { key: '5', value: 2, label: 'Half' },
  { key: '6', value: 1, label: 'Whole' },
];

export interface Caret {
  lane: Lane;
  /** The bar number (0 is the pickup). */
  bar: number;
  /** Ticks from the bar's start. */
  onset: number;
}

export interface InputState {
  caret: Caret;
  duration: Duration;
  /** An accidental to put on the next letter (set when no note ends at the caret to take it); null follows the key. */
  alter: Alter | null;
  /** The pitch the next letter is placed nearest to. */
  last: Pitch;
  /** A tie was asked for on the note before the caret: the next note entered closes it. */
  tieNext: boolean;
  /** The caret is past the last bar; Enter adds one. */
  atEnd: boolean;
}

/** What a step needs to know about one existing item, read from the score. */
export interface InputItem {
  id: Id;
  kind: 'note' | 'rest';
  onset: number;
  ticks: number;
  duration: Duration;
  /** Lowest first; empty for a rest. */
  pitches: Pitch[];
  tie: TieRole;
}

export interface InputContext {
  time: TimeSignature;
  key: KeySignature;
  /** The grid's bar numbers, ascending. */
  bars: readonly number[];
  qualifier: (lane: Lane) => string;
  voices: (staff: number) => number[];
  items: (lane: Lane, bar: number) => InputItem[];
  clef: (staff: number) => Clef;
}

export type InputAction =
  | { type: 'duration'; value: NoteValue }
  | { type: 'dot' }
  | { type: 'pitch'; step: Step; add: boolean }
  | { type: 'rest' }
  | { type: 'accidental'; delta: -1 | 0 | 1 }
  | { type: 'tie' }
  | { type: 'shift'; steps: number }
  | { type: 'advance' }
  | { type: 'back' }
  | { type: 'move'; direction: -1 | 1 }
  | { type: 'voice'; voice: number }
  | { type: 'exit' };

export interface InputResult {
  state: InputState;
  ops: Operation[];
  /** One line for the panel: why nothing happened, or what a refusal needs. */
  message: string | null;
  exit?: boolean;
}

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The key map. `null` is a key the mode does not claim (it passes through to the page). */
export function actionForKey(event: KeyLike): InputAction | null {
  const { key } = event;
  // Voice switching: ctrl+alt+1..4 (by `code`, since alt changes `key` on some layouts).
  if (event.ctrlKey && event.altKey && !event.metaKey && event.code !== undefined) {
    const voice = /^Digit([1-4])$/.exec(event.code);
    return voice === null ? null : { type: 'voice', voice: Number(voice[1]) };
  }
  const mod = event.ctrlKey || event.metaKey;
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    if (event.altKey) return null;
    return { type: 'shift', steps: (key === 'ArrowUp' ? 1 : -1) * (mod ? 7 : 1) };
  }
  if (mod || event.altKey) return null;
  switch (key) {
    case 'ArrowLeft':
      return { type: 'move', direction: -1 };
    case 'ArrowRight':
      return { type: 'move', direction: 1 };
    case 'Enter':
    case ' ':
      return { type: 'advance' };
    case 'Backspace':
    case 'Delete':
      return { type: 'back' };
    case 'Escape':
      return { type: 'exit' };
    case '.':
      return { type: 'dot' };
    case '+':
    case '=':
    case '#':
      return { type: 'accidental', delta: 1 };
    case '-':
    case '_':
      return { type: 'accidental', delta: -1 };
    case '0':
      return { type: 'accidental', delta: 0 };
  }
  const duration = DURATION_KEYS.find((entry) => entry.key === key);
  if (duration !== undefined) return { type: 'duration', value: duration.value };
  const lower = key.toLowerCase();
  if (lower === 'r') return { type: 'rest' };
  if (lower === 't') return { type: 'tie' };
  if (/^[a-g]$/.test(lower)) return { type: 'pitch', step: lower.toUpperCase() as Step, add: event.shiftKey };
  return null;
}

// ---------------------------------------------------------------------------
// Reading the score
// ---------------------------------------------------------------------------

/** A read-only view of the score for the steps below. Built fresh before every step. */
export function inputContext(score: Score): InputContext {
  const staves = allStaves(score);
  const voiceOfLane = (lane: Lane): { staff: Id; voice: number } | null => {
    const staff = staves[lane.staff - 1];
    return staff === undefined ? null : { staff: staff.id, voice: lane.voice };
  };
  return {
    time: score.meta.time,
    key: score.meta.key,
    bars: score.bars.map((bar) => bar.number).sort((a, b) => a - b),
    qualifier: (lane) => qualifierOf(score, lane),
    voices: (staff) => {
      const found = staves[staff - 1];
      return found === undefined ? [1] : voiceIndexes(found);
    },
    clef: (staff) => staves[staff - 1]?.clef ?? 'treble',
    items: (lane, number) => {
      const bar = score.bars.find((candidate) => candidate.number === number);
      const where = voiceOfLane(lane);
      if (bar === undefined || where === null) return [];
      const view = barView(score, bar, where);
      return view.items
        .map((item): InputItem => {
          const tones = item.kind === 'note' ? chordTones(item) : [];
          return {
            id: item.id,
            kind: item.kind,
            onset: item.onset,
            ticks: itemTicks(item, view),
            duration: item.duration,
            pitches: tones.map((tone) => tone.pitch),
            tie: item.kind === 'note' ? item.tie : 'none',
          };
        })
        .sort((a, b) => a.onset - b.onset);
    },
  };
}

function capacity(ctx: InputContext): number {
  return barCapacity(ctx.time);
}

function hasNotes(items: readonly InputItem[]): boolean {
  return items.some((item) => item.kind === 'note');
}

/** Where typing starts when a bar is chosen: after its last note, or its start when it holds none (or is full). */
function endOfContent(ctx: InputContext, lane: Lane, bar: number): number {
  const items = ctx.items(lane, bar);
  if (!hasNotes(items)) return 0;
  const end = Math.max(...items.filter((item) => item.kind === 'note').map((item) => item.onset + item.ticks));
  return end < capacity(ctx) ? end : 0;
}

/** The pitch last entered before the caret in this lane, or the clef's middle. */
function referencePitch(ctx: InputContext, caret: Caret): Pitch {
  for (let at = ctx.bars.indexOf(caret.bar); at >= 0; at--) {
    const number = ctx.bars[at]!;
    const before = ctx.items(caret.lane, number).filter((item) => item.kind === 'note' && (number !== caret.bar || item.onset < caret.onset));
    const last = before[before.length - 1];
    if (last !== undefined && last.pitches.length > 0) return last.pitches[last.pitches.length - 1]!;
  }
  return parsePitchText(seedPitchFor(ctx.clef(caret.lane.staff)));
}

function parsePitchText(text: string): Pitch {
  const match = /^([A-G])(#|b)?(\d)$/.exec(text)!;
  return { step: match[1] as Step, alter: match[2] === '#' ? 1 : match[2] === 'b' ? -1 : 0, octave: Number(match[3]) };
}

/**
 * Open the mode: at an explicit caret (a selected note) or in a chosen bar, else at the first bar of the lane that
 * holds no notes, else past the end of the chart.
 */
export function startInput(
  ctx: InputContext,
  lane: Lane,
  from: { bar?: number; onset?: number } = {},
  duration: Duration = { value: 4, dots: 0 },
): InputState {
  let bar = from.bar;
  let onset = from.onset;
  let atEnd = false;
  if (bar === undefined || !ctx.bars.includes(bar)) {
    bar = ctx.bars.find((number) => number >= 1 && !hasNotes(ctx.items(lane, number)));
    onset = 0;
    if (bar === undefined) {
      bar = ctx.bars[ctx.bars.length - 1] ?? 1;
      onset = capacity(ctx);
      atEnd = true;
    }
  } else if (onset === undefined) {
    onset = endOfContent(ctx, lane, bar);
  }
  const caret: Caret = { lane, bar, onset: onset ?? 0 };
  return { caret, duration, alter: null, last: referencePitch(ctx, caret), tieNext: false, atEnd };
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

const VALUES_DESCENDING: readonly NoteValue[] = [1, 2, 4, 8, 16, 32];

/**
 * A span of ticks as the fewest legal durations, largest first (a dotted value counts). A note that does not fit
 * the bar is written as these pieces, tied.
 */
export function splitTicks(ticks: number): Duration[] {
  const pieces: Duration[] = [];
  let left = ticks;
  while (left > 0) {
    let best: Duration | null = null;
    let bestTicks = 0;
    for (const value of VALUES_DESCENDING) {
      for (const dots of [2, 1, 0] as Dots[]) {
        const candidate = durationTicks({ value, dots });
        if (candidate <= left && candidate > bestTicks) {
          best = { value, dots };
          bestTicks = candidate;
        }
      }
    }
    if (best === null) break; // less than a 32nd: nothing legal fits, leave it
    pieces.push(best);
    left -= bestTicks;
  }
  return pieces;
}

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------

function diatonic(pitch: Pitch): number {
  return pitch.octave * 7 + STEPS.indexOf(pitch.step);
}

function fromDiatonic(index: number, alter: Alter): Pitch {
  const octave = Math.floor(index / 7);
  return { step: STEPS[index - octave * 7]!, alter, octave };
}

/** The octave of `step` nearest to `reference`, or the nearest strictly above it. */
export function nearestPitch(step: Step, reference: Pitch, alter: Alter, above = false): Pitch {
  const target = diatonic(reference);
  const base = STEPS.indexOf(step);
  let best = Number.NaN;
  for (let octave = reference.octave - 2; octave <= reference.octave + 2; octave++) {
    const candidate = octave * 7 + base;
    if (above) {
      if (candidate <= target) continue;
      if (Number.isNaN(best) || candidate < best) best = candidate;
    } else if (Number.isNaN(best) || Math.abs(candidate - target) < Math.abs(best - target)) {
      best = candidate;
    }
  }
  return fromDiatonic(best, alter);
}

function keyAlter(ctx: InputContext, step: Step): Alter {
  return keySignatureAccidentals(ctx.key).get(step) ?? 0;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

function address(ctx: InputContext, lane: Lane, bar: number, onset: number): string {
  return `${ctx.qualifier(lane)}bar${bar}.beat${formatBeat(beatOfOnset(onset, ctx.time))}`;
}

/** The address of one pitch of the item at a position (`s1.v1.bar2.beat3.E4`). */
function toneAddress(ctx: InputContext, lane: Lane, bar: number, onset: number, pitch: Pitch): string {
  return `${address(ctx, lane, bar, onset)}.${formatPitch(pitch)}`;
}

function nextBar(ctx: InputContext, bar: number): number | null {
  return ctx.bars[ctx.bars.indexOf(bar) + 1] ?? null;
}

function previousBar(ctx: InputContext, bar: number): number | null {
  const at = ctx.bars.indexOf(bar);
  return at > 0 ? ctx.bars[at - 1]! : null;
}

/** The caret moved to `ticks` later, spilling into the next bar or past the end. */
function advanced(ctx: InputContext, caret: Caret, ticks: number): { caret: Caret; atEnd: boolean } {
  const onset = caret.onset + ticks;
  if (onset < capacity(ctx)) return { caret: { ...caret, onset }, atEnd: false };
  const next = nextBar(ctx, caret.bar);
  if (next === null) return { caret: { ...caret, onset: capacity(ctx) }, atEnd: true };
  return { caret: { ...caret, bar: next, onset: onset - capacity(ctx) }, atEnd: false };
}

/** The item that ends exactly where the caret is (the "previous note" the arrow keys, tie and accidentals act on). */
function previousItem(ctx: InputContext, caret: Caret): { item: InputItem; bar: number } | null {
  const here = ctx.items(caret.lane, caret.bar);
  const before = here.filter((item) => item.onset < caret.onset);
  const last = before[before.length - 1];
  if (last !== undefined) return last.onset + last.ticks === caret.onset ? { item: last, bar: caret.bar } : null;
  if (caret.onset !== 0) return null;
  const previous = previousBar(ctx, caret.bar);
  if (previous === null) return null;
  const items = ctx.items(caret.lane, previous);
  const tail = items[items.length - 1];
  return tail !== undefined && tail.onset + tail.ticks === capacity(ctx) ? { item: tail, bar: previous } : null;
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

const END_MESSAGE = 'End of the chart: press Enter to add a bar.';

function done(state: InputState, ops: Operation[] = [], message: string | null = null): InputResult {
  return { state, ops, message };
}

function tieRole(before: boolean, after: boolean): TieRole {
  if (before && after) return 'both';
  if (before) return 'stop';
  return after ? 'start' : 'none';
}

/** One key's worth of editing: the next state and the ops that go with it. */
export function stepInput(state: InputState, action: InputAction, ctx: InputContext): InputResult {
  const { caret } = state;
  switch (action.type) {
    case 'exit':
      return { state, ops: [], message: null, exit: true };

    case 'duration':
      return done({ ...state, duration: { value: action.value, dots: 0 } });

    case 'dot':
      return done({ ...state, duration: { ...state.duration, dots: state.duration.dots === 0 ? 1 : 0 } });

    case 'voice': {
      if (!ctx.voices(caret.lane.staff).includes(action.voice)) {
        return done(state, [], `Voice ${action.voice} does not exist on this staff yet: add it in the Staves panel.`);
      }
      const lane = { ...caret.lane, voice: action.voice };
      const next: Caret = { ...caret, lane };
      return done({ ...state, caret: next, tieNext: false, alter: null, last: referencePitch(ctx, next) });
    }

    case 'move': {
      const items = ctx.items(caret.lane, caret.bar);
      const stops = [...new Set([0, ...items.flatMap((item) => [item.onset, item.onset + item.ticks])])]
        .filter((onset) => onset < capacity(ctx))
        .sort((a, b) => a - b);
      let next: Caret = caret;
      let atEnd = false;
      if (action.direction === 1) {
        const later = state.atEnd ? undefined : stops.find((onset) => onset > caret.onset);
        if (later !== undefined) next = { ...caret, onset: later };
        else if (!state.atEnd) {
          const bar = nextBar(ctx, caret.bar);
          if (bar === null) {
            next = { ...caret, onset: capacity(ctx) };
            atEnd = true;
          } else next = { ...caret, bar, onset: 0 };
        } else atEnd = true;
      } else if (state.atEnd) {
        next = { ...caret, onset: stops[stops.length - 1] ?? 0 };
      } else {
        const earlier = [...stops].reverse().find((onset) => onset < caret.onset);
        if (earlier !== undefined) next = { ...caret, onset: earlier };
        else {
          const bar = previousBar(ctx, caret.bar);
          if (bar !== null) {
            const there = ctx.items(caret.lane, bar);
            const tail = there[there.length - 1];
            next = { ...caret, bar, onset: tail === undefined ? 0 : tail.onset };
          }
        }
      }
      return done({ ...state, caret: next, atEnd, tieNext: false, alter: null, last: referencePitch(ctx, next) });
    }

    case 'advance': {
      if (state.atEnd) {
        const bar = (ctx.bars[ctx.bars.length - 1] ?? 0) + 1;
        const next: Caret = { ...caret, bar, onset: 0 };
        return done({ ...state, caret: next, atEnd: false }, [{ type: 'bar.add' }]);
      }
      const moved = advanced(ctx, caret, durationTicks(state.duration));
      return done({ ...state, caret: moved.caret, atEnd: moved.atEnd, tieNext: false, alter: null });
    }

    case 'back': {
      if (state.atEnd) {
        const items = ctx.items(caret.lane, caret.bar);
        const tail = items[items.length - 1];
        if (tail === undefined || tail.onset + tail.ticks !== capacity(ctx)) {
          return done({ ...state, atEnd: false, caret: { ...caret, onset: tail === undefined ? 0 : tail.onset } });
        }
      }
      const found = previousItem(ctx, caret);
      if (found === null) {
        // Nothing ends here: step the caret back over a gap, or to the previous bar's end.
        if (caret.onset === 0 && previousBar(ctx, caret.bar) === null) return done(state, [], 'Nothing before the caret.');
        return stepInput(state, { type: 'move', direction: -1 }, ctx);
      }
      const op: Operation = { type: found.item.kind === 'note' ? 'note.rm' : 'rest.rm', target: found.item.id };
      const next: Caret = { lane: caret.lane, bar: found.bar, onset: found.item.onset };
      return done({ ...state, caret: next, atEnd: false, tieNext: false, alter: null, last: referencePitch(ctx, next) }, [op]);
    }

    case 'accidental': {
      const found = state.atEnd ? null : previousItem(ctx, caret);
      if (found === null || found.item.kind !== 'note') {
        const base = state.alter ?? 0;
        const alter = action.delta === 0 ? 0 : (Math.max(-2, Math.min(2, base + action.delta)) as Alter);
        return done({ ...state, alter });
      }
      const ops = found.item.pitches.map((pitch): Operation => {
        const alter = action.delta === 0 ? 0 : (Math.max(-2, Math.min(2, pitch.alter + action.delta)) as Alter);
        return {
          type: 'note.set',
          target: toneAddress(ctx, caret.lane, found.bar, found.item.onset, pitch),
          payload: { pitch: formatPitch({ ...pitch, alter }) },
        };
      });
      const top = found.item.pitches[found.item.pitches.length - 1]!;
      const alter = action.delta === 0 ? 0 : (Math.max(-2, Math.min(2, top.alter + action.delta)) as Alter);
      return done({ ...state, last: { ...top, alter } }, orderForRepitch(ops, action.delta));
    }

    case 'shift': {
      const found = state.atEnd ? null : previousItem(ctx, caret);
      if (found === null || found.item.kind !== 'note') return done(state, [], 'Enter a note first, then use the arrows to move it.');
      const moved = found.item.pitches.map((pitch) => fromDiatonic(diatonic(pitch) + action.steps, pitch.alter));
      const ops = found.item.pitches.map(
        (pitch, at): Operation => ({
          type: 'note.set',
          target: toneAddress(ctx, caret.lane, found.bar, found.item.onset, pitch),
          payload: { pitch: formatPitch(moved[at]!) },
        }),
      );
      return done({ ...state, last: moved[moved.length - 1]! }, orderForRepitch(ops, action.steps));
    }

    case 'tie': {
      const found = state.atEnd ? null : previousItem(ctx, caret);
      if (found === null || found.item.kind !== 'note') return done(state, [], 'Tie needs a note just before the caret.');
      const was = found.item.tie;
      const nowTied = was === 'none' || was === 'stop';
      const role: TieRole = was === 'none' ? 'start' : was === 'stop' ? 'both' : was === 'start' ? 'none' : 'stop';
      const ops = found.item.pitches.map(
        (pitch): Operation => ({
          type: 'note.set',
          target: toneAddress(ctx, caret.lane, found.bar, found.item.onset, pitch),
          payload: { tie: role },
        }),
      );
      return done({ ...state, tieNext: nowTied }, ops);
    }

    case 'rest':
      return enter(state, ctx, { kind: 'rest' });

    case 'pitch': {
      if (state.atEnd) return done(state, [], END_MESSAGE);
      const found = action.add ? previousItem(ctx, caret) : null;
      if (action.add && found !== null && found.item.kind === 'note') {
        const alter = state.alter ?? keyAlter(ctx, action.step);
        const top = found.item.pitches[found.item.pitches.length - 1]!;
        const pitch = nearestPitch(action.step, top, alter, true);
        const op: Operation = {
          type: 'note.add',
          target: address(ctx, caret.lane, found.bar, found.item.onset),
          payload: { pitch: formatPitch(pitch), duration: found.item.duration },
        };
        return done({ ...state, alter: null, last: pitch }, [op]);
      }
      const alter = state.alter ?? keyAlter(ctx, action.step);
      return enter(state, ctx, { kind: 'note', pitch: nearestPitch(action.step, state.last, alter) });
    }
  }
}

/** A set of repitching `note.set`s of one chord, ordered so a tone never lands on one not yet moved. */
function orderForRepitch(ops: Operation[], direction: number): Operation[] {
  return direction > 0 ? [...ops].reverse() : ops;
}

type Entry = { kind: 'rest' } | { kind: 'note'; pitch: Pitch };

/** Write a note or a rest at the caret over whatever is there, splitting at the barline with ties, and advance. */
function enter(state: InputState, ctx: InputContext, entry: Entry): InputResult {
  if (state.atEnd) return done(state, [], END_MESSAGE);
  const ops: Operation[] = [];
  const total = durationTicks(state.duration);
  let caret = state.caret;
  let left = total;
  let atEnd = false;
  const pieces: Array<{ caret: Caret; duration: Duration }> = [];
  while (left > 0) {
    const room = capacity(ctx) - caret.onset;
    const take = Math.min(left, room);
    const parts = take === total ? [state.duration] : splitTicks(take);
    if (parts.length === 0) break;
    let at = caret;
    for (const duration of parts) {
      pieces.push({ caret: at, duration });
      at = { ...at, onset: at.onset + durationTicks(duration) };
    }
    left -= take;
    if (at.onset >= capacity(ctx)) {
      const bar = nextBar(ctx, at.bar);
      if (bar === null) {
        caret = { ...at, onset: capacity(ctx) };
        atEnd = true;
        break;
      }
      caret = { ...at, bar, onset: 0 };
    } else {
      caret = at;
    }
  }
  if (pieces.length === 0) return done(state, [], 'That does not fit.');

  pieces.forEach((piece, at) => {
    const ticks = durationTicks(piece.duration);
    // Overwrite: the items this one covers go first, as one undo unit with the add.
    for (const existing of ctx.items(piece.caret.lane, piece.caret.bar)) {
      if (existing.onset >= piece.caret.onset && existing.onset < piece.caret.onset + ticks) {
        ops.push({ type: existing.kind === 'note' ? 'note.rm' : 'rest.rm', target: existing.id });
      }
    }
    const target = address(ctx, piece.caret.lane, piece.caret.bar, piece.caret.onset);
    if (entry.kind === 'rest') {
      ops.push({ type: 'rest.add', target, payload: { duration: piece.duration } });
    } else {
      const tie = tieRole(at === 0 ? state.tieNext : true, at < pieces.length - 1);
      ops.push({
        type: 'note.add',
        target,
        payload: { pitch: formatPitch(entry.pitch), duration: piece.duration, ...(tie === 'none' ? {} : { tie }) },
      });
    }
  });

  return done(
    {
      ...state,
      caret,
      atEnd,
      alter: null,
      tieNext: false,
      last: entry.kind === 'note' ? entry.pitch : state.last,
    },
    ops,
    atEnd ? END_MESSAGE : null,
  );
}

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

export const GHOST_ID = 'note-input-ghost';

/**
 * The score with the note the next letter would write, drawn at the caret. It is an ordinary `Score` handed to the
 * one `layout()` + `engravePage()` path, so the preview is engraved by the same code as the page; the adapter only
 * lays a marker over the box of the note whose id is `GHOST_ID`. Items the note would overwrite are left out of the
 * copy, so the preview shows the bar as the edit would leave it. The stored score is never touched.
 */
export function ghostScore(score: Score, state: InputState, ctx: InputContext): Score | null {
  if (state.atEnd) return null;
  const { caret } = state;
  const staff = allStaves(score)[caret.lane.staff - 1];
  const bar = score.bars.find((candidate) => candidate.number === caret.bar);
  if (staff === undefined || bar === undefined) return null;
  const room = capacity(ctx) - caret.onset;
  const ticks = Math.min(durationTicks(state.duration), room);
  const duration = ticks === durationTicks(state.duration) ? state.duration : splitTicks(ticks)[0];
  if (duration === undefined) return null;
  const span = durationTicks(duration);
  return mapBarView(
    score,
    bar.id,
    (view) => ({
      ...view,
      items: [
        ...view.items.filter((item) => item.onset < caret.onset || item.onset >= caret.onset + span),
        makeNote({ id: GHOST_ID, onset: caret.onset, duration, pitch: state.last }),
      ].sort((a, b) => a.onset - b.onset),
    }),
    { staff: staff.id, voice: caret.lane.voice },
  );
}

/** `bar 3 · beat 2` for the panel. */
export function caretLabel(caret: Caret, time: TimeSignature): string {
  return `bar ${caret.bar} · beat ${formatBeat(beatOfOnset(caret.onset, time))}`;
}

/** The caret for a click on an existing item. */
export function caretAtItem(lane: Lane, bar: number, beat: number, time: TimeSignature): Caret {
  return { lane, bar, onset: onsetOfBeat(beat, time) };
}
