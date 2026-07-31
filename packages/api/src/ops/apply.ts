import {
  DEFAULT_KEY,
  DEFAULT_TIME,
  SCHEMA_VERSION,
  isMetricallyValid,
  makeBar,
  makeNote,
  makeRest,
  makeScore,
  nextId,
  noReview,
  parsePitch,
  resolveAddress,
  resolvePosition,
  AddressError,
} from '@sibei/model';
import type {
  Bar,
  BarItem,
  Duration,
  Id,
  KeySignature,
  Note,
  Review,
  Score,
  TimeSignature,
} from '@sibei/model';
import { OperationError } from './errors.js';
import type {
  MetaSetPayload,
  NoteAddPayload,
  NoteSetPayload,
  Operation,
  RestAddPayload,
  ScoreCreatePayload,
} from './operations.js';

/**
 * The applier, as a pure function.
 *
 * `(score, operation) -> {score, operation}`, with no store and no I/O anywhere in it. That
 * shape is what makes ADR-0003's central property *testable*: replaying a log from empty has to
 * reproduce the stored document exactly, and it can only be asserted if applying is separable
 * from persisting. `applier.ts` is the thin transactional wrapper that persists.
 *
 * Two rules govern everything here.
 *
 * **Normalisation.** The returned operation is the one that gets logged, not the one that came
 * in: every value the applier generated — an id, a bar list — is written back into the payload.
 * Replay then reuses the recorded value, so it does not depend on the id policy in force when
 * the operation was first applied. This is what makes replay exact rather than merely likely.
 *
 * **ADR-0013.** A bar whose durations do not sum to the meter is *applied and flagged*, never
 * repaired and never refused. Nothing in this file may reject a bar for its rhythm.
 */

export interface Applied {
  score: Score;
  /** The operation as it should be logged: generated values filled in. */
  operation: Operation;
  /** Ids of the objects this operation touched, for the response's `changed[]`. */
  changed: Id[];
}

export function applyOperation(score: Score | null, operation: Operation, index?: number): Applied {
  try {
    return dispatch(score, operation);
  } catch (error) {
    // The resolver speaks in its own structured failures. Wrap rather than restate, so the
    // message a user sees is the resolver's — the one that lists the bar's real onsets.
    if (error instanceof AddressError) {
      throw new OperationError({ kind: 'address', failure: error.failure }, index);
    }
    if (error instanceof OperationError && error.index === undefined && index !== undefined) {
      throw new OperationError(error.failure, index);
    }
    throw error;
  }
}

function dispatch(score: Score | null, operation: Operation): Applied {
  if (operation.type === 'score.create') {
    if (score !== null) {
      throw new OperationError({ kind: 'conflict-exists', id: score.id });
    }
    return createScore(operation.payload);
  }

  if (score === null) {
    throw new OperationError({
      kind: 'bad-first-operation',
      detail: `${operation.type} needs a score; the first operation on a score must be score.create`,
    });
  }

  switch (operation.type) {
    case 'meta.set':
      return setMeta(score, operation.payload);
    case 'note.add':
      return addNote(score, operation.target, operation.payload);
    case 'note.set':
      return setNote(score, operation.target, operation.payload);
    case 'note.rm':
      return removeItem(score, operation.target, 'note');
    case 'rest.add':
      return addRest(score, operation.target, operation.payload);
    case 'rest.rm':
      return removeItem(score, operation.target, 'rest');
    default: {
      // Unreachable for a well-typed Operation, but an op arriving over HTTP is not well-typed
      // until something checks, and this is that something.
      const unknown = operation as { type: string };
      throw new OperationError({ kind: 'unknown-operation', type: unknown.type });
    }
  }
}

// ---------------------------------------------------------------------------
// score.create
// ---------------------------------------------------------------------------

/**
 * A blank head. 32 bars because that is the length of one, and ADR-0009's own example projection
 * is a 32-bar chart.
 */
export const DEFAULT_BAR_COUNT = 32;

/**
 * Score creation is an operation like any other, which is what keeps replay-from-empty true as a
 * property rather than an aspiration (ADR-0003). It is also why import will be one operation in
 * v0.2 rather than something that happens beside the log.
 */
function createScore(payload: ScoreCreatePayload): Applied {
  if (typeof payload.id !== 'string' || payload.id === '') {
    throw new OperationError({ kind: 'validation', detail: 'score.create needs an id' });
  }

  const bars = payload.bars ?? plannedBars(payload);
  const key = validKey(payload.key);
  const time = validTime(payload.time);

  const score = makeScore({
    id: payload.id,
    ...(payload.title === undefined ? {} : { title: payload.title }),
    ...(payload.composer === undefined ? {} : { composer: payload.composer }),
    ...(payload.style === undefined ? {} : { style: payload.style }),
    key,
    time,
    bars: bars.map((bar) => makeBar({ id: bar.id, number: bar.number })),
  });

  // Every bar of a blank chart is empty, so every numbered bar is metrically short. ADR-0013
  // says flag it, and the projection's `!` is how a reader is pointed at it.
  const flagged = reflagAllBars(score);

  return {
    score: flagged,
    // `bars` recorded: replay creates exactly these, with exactly these ids.
    operation: { type: 'score.create', payload: { ...payload, bars } },
    changed: [payload.id],
  };
}

function plannedBars(payload: ScoreCreatePayload): { id: Id; number: number }[] {
  const count = payload.barCount ?? DEFAULT_BAR_COUNT;
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new OperationError({
      kind: 'validation',
      detail: `barCount must be a whole number between 1 and 1000, not ${JSON.stringify(count)}`,
    });
  }
  const numbers = payload.pickup === true ? [0, ...range(1, count)] : range(1, count);
  return numbers.map((number) => ({ id: `bar-${number}`, number }));
}

function range(from: number, count: number): number[] {
  return Array.from({ length: count }, (_, offset) => from + offset);
}

// ---------------------------------------------------------------------------
// meta.set
// ---------------------------------------------------------------------------

function setMeta(score: Score, payload: MetaSetPayload): Applied {
  const time = payload.time === undefined ? score.meta.time : validTime(payload.time);
  const key = payload.key === undefined ? score.meta.key : validKey(payload.key);

  const next: Score = {
    ...score,
    meta: {
      title: payload.title ?? score.meta.title,
      composer: payload.composer ?? score.meta.composer,
      style: payload.style === undefined ? score.meta.style : payload.style,
      key,
      time,
    },
  };

  // Changing the meter changes which bars are metrically valid without touching a single note,
  // so the flags have to be recomputed rather than left where they were.
  return {
    score: reflagAllBars(next),
    operation: { type: 'meta.set', payload },
    changed: [score.id],
  };
}

// ---------------------------------------------------------------------------
// note.add, rest.add
// ---------------------------------------------------------------------------

function addNote(score: Score, target: string, payload: NoteAddPayload): Applied {
  const position = resolvePosition(score, target);
  refuseOccupiedOnset(position.bar, position.onset, target);

  const id = payload.id ?? nextId(score, 'note');
  const note = makeNote({
    id,
    onset: position.onset,
    duration: validDuration(payload.duration),
    pitch: validPitch(payload.pitch),
    ...(payload.accidental === undefined ? {} : { accidental: payload.accidental }),
    ...(payload.tie === undefined ? {} : { tie: payload.tie }),
    ...(payload.spellingPinned === undefined ? {} : { spellingPinned: payload.spellingPinned }),
  });

  return {
    score: withItemAdded(score, position.bar.id, note),
    operation: { type: 'note.add', target, payload: { ...payload, id } },
    changed: [id],
  };
}

function addRest(score: Score, target: string, payload: RestAddPayload): Applied {
  const position = resolvePosition(score, target);
  refuseOccupiedOnset(position.bar, position.onset, target);

  const id = payload.id ?? nextId(score, 'rest');
  const rest = makeRest({ id, onset: position.onset, duration: validDuration(payload.duration) });

  return {
    score: withItemAdded(score, position.bar.id, rest),
    operation: { type: 'rest.add', target, payload: { ...payload, id } },
    changed: [id],
  };
}

/**
 * Two items at one onset would be a second voice, and the single-staff single-voice assumption is
 * load-bearing in the layout engine rather than incidental (PLAN.md). So a write is refused here.
 *
 * Note the deliberate asymmetry with ADR-0013, which is about *rhythm*: a bar whose durations do
 * not sum to the meter is stored and flagged, and this file will happily create one. What it will
 * not do is stack two onsets. **Read leniently, write strictly** — the address resolver copes with
 * a shared onset because an imported document may contain one, but nothing here needs to make a
 * fresh one.
 */
function refuseOccupiedOnset(bar: Bar, onset: number, target: string): void {
  const existing = bar.items.find((item) => item.onset === onset);
  if (existing === undefined) return;
  throw new OperationError({
    kind: 'validation',
    detail:
      `${target} already has a ${existing.kind} on it (${existing.id}). A bar carries one voice, ` +
      `so set or remove that one rather than stacking another onto it.`,
  });
}

/** Items are kept in onset order, which `Bar.items` documents and addressing relies on. */
function withItemAdded(score: Score, barId: Id, item: BarItem): Score {
  return mapBar(score, barId, (bar) => ({
    ...bar,
    items: [...bar.items, item].sort((a, b) => a.onset - b.onset),
  }));
}

// ---------------------------------------------------------------------------
// note.set
// ---------------------------------------------------------------------------

function setNote(score: Score, target: string, payload: NoteSetPayload): Applied {
  const resolved = resolveAddress(score, target, 'note');
  const note = resolved.target as Note;

  const updated: Note = {
    ...note,
    ...(payload.pitch === undefined ? {} : { pitch: validPitch(payload.pitch) }),
    ...(payload.duration === undefined ? {} : { duration: validDuration(payload.duration) }),
    ...(payload.accidental === undefined ? {} : { accidental: payload.accidental }),
    ...(payload.tie === undefined ? {} : { tie: payload.tie }),
    ...(payload.spellingPinned === undefined ? {} : { spellingPinned: payload.spellingPinned }),
  };

  return {
    score: mapBar(score, resolved.bar.id, (bar) => ({
      ...bar,
      items: bar.items.map((item) => (item.id === note.id ? updated : item)),
    })),
    operation: { type: 'note.set', target, payload },
    changed: [note.id],
  };
}

// ---------------------------------------------------------------------------
// note.rm, rest.rm
// ---------------------------------------------------------------------------

function removeItem(score: Score, target: string, kind: 'note' | 'rest'): Applied {
  const resolved = resolveAddress(score, target, kind);
  const id = resolved.target.id;

  // A removed item may be a tuplet member. Dropping it from the grouping keeps the bar coherent;
  // a tuplet left holding a dangling id would be a document that says something untrue.
  return {
    score: mapBar(score, resolved.bar.id, (bar) => ({
      ...bar,
      items: bar.items.filter((item) => item.id !== id),
      tuplets: bar.tuplets
        .map((tuplet) => ({ ...tuplet, memberIds: tuplet.memberIds.filter((m) => m !== id) }))
        .filter((tuplet) => tuplet.memberIds.length > 0),
    })),
    operation: kind === 'note' ? { type: 'note.rm', target } : { type: 'rest.rm', target },
    changed: [id],
  };
}

// ---------------------------------------------------------------------------
// Bar rewriting, and the metric flag
// ---------------------------------------------------------------------------

/** Rewrite one bar, then bring its review flag back in line with its rhythm. */
function mapBar(score: Score, barId: Id, change: (bar: Bar) => Bar): Score {
  return {
    ...score,
    bars: score.bars.map((bar) => (bar.id === barId ? reflag(change(bar), score.meta.time) : bar)),
  };
}

function reflagAllBars(score: Score): Score {
  return { ...score, bars: score.bars.map((bar) => reflag(bar, score.meta.time)) };
}

/**
 * Metric validity is derived, never an invariant (ADR-0013). This is the *flagging* half of
 * "stored and flagged": a bar that does not sum to the meter carries `metrically-invalid` in its
 * review, and one that does no longer carries it.
 *
 * Only that one reason is touched. v0.2 sets `low-confidence` and friends from the import
 * pipeline, and a rhythm edit has no business clearing those.
 */
function reflag(bar: Bar, time: TimeSignature): Bar {
  const invalid = !isMetricallyValid(bar, time);
  const others = bar.review.reasons.filter((reason) => reason !== 'metrically-invalid');
  const reasons = invalid ? [...others, 'metrically-invalid' as const] : others;
  const review: Review = { flagged: reasons.length > 0, reasons };
  return { ...bar, review };
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

const NOTE_VALUES = [1, 2, 4, 8, 16, 32];

function validDuration(duration: Duration | undefined): Duration {
  if (duration === null || typeof duration !== 'object') {
    throw new OperationError({ kind: 'validation', detail: 'a duration is required' });
  }
  if (!NOTE_VALUES.includes(duration.value)) {
    throw new OperationError({
      kind: 'validation',
      detail: `${JSON.stringify(duration.value)} is not a note value; use one of ${NOTE_VALUES.join(', ')}`,
    });
  }
  if (![0, 1, 2].includes(duration.dots)) {
    throw new OperationError({
      kind: 'validation',
      detail: `a duration carries 0, 1 or 2 dots, not ${JSON.stringify(duration.dots)}`,
    });
  }
  return { value: duration.value, dots: duration.dots };
}

function validPitch(pitch: NoteAddPayload['pitch']): Note['pitch'] {
  if (typeof pitch === 'string') {
    try {
      return parsePitch(pitch);
    } catch {
      throw new OperationError({
        kind: 'validation',
        detail: `${JSON.stringify(pitch)} is not a pitch; write one like Eb5 or F#4`,
      });
    }
  }
  if (pitch === null || typeof pitch !== 'object') {
    throw new OperationError({ kind: 'validation', detail: 'a pitch is required' });
  }
  // Round-trip through the parser so one place decides what a pitch is.
  const alter = pitch.alter;
  if (![-2, -1, 0, 1, 2].includes(alter)) {
    throw new OperationError({
      kind: 'validation',
      detail: `${JSON.stringify(alter)} is not an alteration; -2 to 2`,
    });
  }
  if (!Number.isInteger(pitch.octave) || pitch.octave < -1 || pitch.octave > 9) {
    throw new OperationError({
      kind: 'validation',
      detail: `${JSON.stringify(pitch.octave)} is not an octave; -1 to 9`,
    });
  }
  if (!'CDEFGAB'.includes(pitch.step) || pitch.step.length !== 1) {
    throw new OperationError({
      kind: 'validation',
      detail: `${JSON.stringify(pitch.step)} is not a step; A to G`,
    });
  }
  return { step: pitch.step as Note['pitch']['step'], alter: alter as -2 | -1 | 0 | 1 | 2, octave: pitch.octave };
}

function validKey(key: KeySignature | undefined): KeySignature {
  if (key === undefined) return DEFAULT_KEY;
  if (key === null || typeof key !== 'object' || !'CDEFGAB'.includes(key.tonic)) {
    throw new OperationError({ kind: 'validation', detail: 'a key needs a tonic from A to G' });
  }
  if (![-2, -1, 0, 1, 2].includes(key.alter)) {
    throw new OperationError({ kind: 'validation', detail: 'a key alteration runs -2 to 2' });
  }
  if (key.mode !== 'major' && key.mode !== 'minor') {
    throw new OperationError({ kind: 'validation', detail: 'a key is major or minor' });
  }
  return { tonic: key.tonic, alter: key.alter, mode: key.mode };
}

function validTime(time: TimeSignature | undefined): TimeSignature {
  if (time === undefined) return DEFAULT_TIME;
  if (time === null || typeof time !== 'object') {
    throw new OperationError({ kind: 'validation', detail: 'a time signature is required' });
  }
  if (!Number.isInteger(time.beats) || time.beats < 1 || time.beats > 32) {
    throw new OperationError({
      kind: 'validation',
      detail: `a time signature has 1 to 32 beats, not ${JSON.stringify(time.beats)}`,
    });
  }
  if (!NOTE_VALUES.includes(time.beatValue)) {
    throw new OperationError({
      kind: 'validation',
      detail: `${JSON.stringify(time.beatValue)} is not a beat value; use one of ${NOTE_VALUES.join(', ')}`,
    });
  }
  return { beats: time.beats, beatValue: time.beatValue };
}

/** Replay: fold a whole log from nothing (ADR-0003's undo mechanism, and its test). */
export function replay(operations: readonly Operation[]): Score | null {
  let score: Score | null = null;
  for (const [index, operation] of operations.entries()) {
    score = applyOperation(score, operation, index).score;
  }
  return score;
}

/** The document schema every applied score is written at. */
export const APPLIED_SCHEMA_VERSION = SCHEMA_VERSION;

/** Exported for the flag test: a bar with no reasons is not flagged. */
export const emptyReview = noReview;
