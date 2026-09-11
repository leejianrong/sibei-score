import {
  DEFAULT_KEY,
  DEFAULT_TIME,
  SCHEMA_VERSION,
  barReview,
  makeBar,
  makeChord,
  makeNote,
  makeRest,
  makeScore,
  makeSection,
  nextId,
  noReview,
  parsePitch,
  resolveAddress,
  resolveBar,
  resolvePosition,
  sectionStartingAt,
  keyInterval,
  transposePitch,
  AddressError,
} from '@sibei/model';
import type {
  Bar,
  BarItem,
  Chord,
  Duration,
  EndBarline,
  Ending,
  EndingRole,
  Id,
  KeySignature,
  Note,
  Review,
  Score,
  StartBarline,
  TimeSignature,
} from '@sibei/model';
import { parseChord, transposeChordText } from '@sibei/music';
import { OperationError } from './errors.js';
import { isControlOperation } from './operations.js';
import type {
  ChordSetPayload,
  MetaSetPayload,
  NoteAddPayload,
  BarlineSetPayload,
  EndingSetPayload,
  LoggedOperation,
  NoteSetPayload,
  Operation,
  RestAddPayload,
  ScoreCreatePayload,
  ScoreImportPayload,
  SectionSetPayload,
  StoredOperation,
  TransposePayload,
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

  if (operation.type === 'score.import') {
    // A whole document in one operation (ADR-0003), the create-from-snapshot behind `duplicate` and
    // v0.2's import. It is a first operation like `score.create`, so it too needs an empty score.
    if (score !== null) {
      throw new OperationError({ kind: 'conflict-exists', id: score.id });
    }
    return importScore(operation.payload);
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
    case 'chord.set':
      return setChord(score, operation.target, operation.payload);
    case 'chord.rm':
      return removeChord(score, operation.target);
    case 'transpose':
      return transpose(score, operation.payload);
    case 'section.set':
      return setSection(score, operation.target, operation.payload);
    case 'section.rm':
      return removeSection(score, operation.target);
    case 'barline.set':
      return setBarline(score, operation.target, operation.payload);
    case 'ending.set':
      return setEnding(score, operation.target, operation.payload);
    case 'ending.rm':
      return removeEnding(score, operation.target);
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
 * Import a whole document as one operation (V8c, ADR-0003) — the create-from-snapshot behind
 * `duplicate`. The document is *recorded in the payload*, so replay reproduces it exactly with no
 * dependence on anything outside the log, which is the property duplicate rests on: the copy's log
 * is a single `score.import`, so replaying it from empty is the copy, and the copy has nothing to
 * undo. The returned score is cloned off the payload so the stored document and the logged operation
 * never alias.
 */
function importScore(payload: ScoreImportPayload): Applied {
  const document = payload.document;
  if (typeof document?.id !== 'string' || document.id === '') {
    throw new OperationError({ kind: 'validation', detail: 'score.import needs a document with an id' });
  }
  return {
    score: structuredClone(document),
    operation: { type: 'score.import', payload: { document } },
    changed: [document.id],
  };
}

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

  // A blank chart now comes out with no flags on it, because an empty bar is not a review case
  // (KAN-597): this used to leave every one of 32 bars flagged, which is a review signal firing on
  // 100% of every new document. So for a blank head this is a no-op — and it stays anyway, because
  // v0.2's import is one `score.create` (see above) and the bars it opens will hold notes.
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
// chord.set, chord.rm
// ---------------------------------------------------------------------------

/**
 * Set a chord symbol at a beat (Q32). An upsert: the chord already on that beat has its text
 * replaced, keeping its id; an empty beat gets a new chord. There is no `refuseOccupiedOnset`
 * here, and that asymmetry with `note.add` is the point — a note stacked on a beat would be a
 * second voice, but a *second chord symbol on the same beat* is not a thing, so setting one
 * replaces rather than refuses. A chord at a *different* beat in the same bar is how two chords
 * share a bar, and the address is what keeps them apart.
 *
 * The text is stored exactly as given. The grammar decides only the flag: unparseable text is
 * kept and flagged `unparsed-chord`, never rejected (ADR-0012).
 */
function setChord(score: Score, target: string, payload: ChordSetPayload): Applied {
  const position = resolvePosition(score, target);
  const text = validChordText(payload.text);
  const existing = position.bar.chords.find((chord) => chord.onset === position.onset);
  const id = existing?.id ?? nextId(score, 'chord');

  // An upsert keeps the pin it does not touch: re-typing the text without `--spell` leaves an
  // existing pin as it was, and `--spell` sets it either way (ADR-0017).
  const spellingPinned = payload.spellingPinned ?? existing?.spellingPinned ?? false;
  const chord = makeChord({ id, onset: position.onset, text, spellingPinned, review: chordReview(text) });

  return {
    score: mapBar(score, position.bar.id, (bar) => ({
      ...bar,
      chords: [...bar.chords.filter((other) => other.id !== id), chord].sort((a, b) => a.onset - b.onset),
    })),
    operation: { type: 'chord.set', target, payload: { ...payload, id } },
    changed: [id],
  };
}

function removeChord(score: Score, target: string): Applied {
  const resolved = resolveAddress(score, target, 'chord');
  const chord = resolved.target as Chord;

  return {
    score: mapBar(score, resolved.bar.id, (bar) => ({
      ...bar,
      chords: bar.chords.filter((other) => other.id !== chord.id),
    })),
    operation: { type: 'chord.rm', target },
    changed: [chord.id],
  };
}

// ---------------------------------------------------------------------------
// transpose
// ---------------------------------------------------------------------------

/**
 * Transpose the whole chart into a new concert key (ADR-0016). The score always stores concert
 * pitch, so this genuinely changes the tune: the melody moves by the interval between the current
 * key and the target and is respelled by the destination key signature, honouring per-note pins
 * (ADR-0017); chord roots and slash basses move with it. The key signature itself becomes the
 * target.
 *
 * It is a mutation on the one write path like any other op, which is what makes it undoable later
 * (V8) without any special-casing. Nothing is recorded into the payload beyond the target key: the
 * respelling is a pure function of the score's key at apply time and the target, and replay
 * reproduces both, so recording per-object results would add nothing replay does not already have.
 *
 * Rhythm is untouched, so metric validity cannot change — but the bars are reflagged anyway, the
 * same no-op `meta.set` performs, so the stored write-through flag can never fall out of step with
 * the rule that derives it.
 */
function transpose(score: Score, payload: TransposePayload): Applied {
  const to = validKey(payload.to);
  const interval = keyInterval(score.meta.key, to);
  const changed: Id[] = [];

  const bars = score.bars.map((bar) => {
    const items = bar.items.map((item) => {
      if (item.kind !== 'note') return item;
      changed.push(item.id);
      return { ...item, pitch: transposePitch(item.pitch, interval, to, item.spellingPinned) };
    });
    const chords = bar.chords.map((chord) => {
      const moved = transposeChordText(chord.text, interval, to, chord.spellingPinned);
      if (moved === chord.text) return chord;
      changed.push(chord.id);
      return { ...chord, text: moved };
    });
    return reflag({ ...bar, items, chords }, score.meta.time);
  });

  const next: Score = { ...score, meta: { ...score.meta, key: to }, bars };
  return {
    score: next,
    operation: { type: 'transpose', payload: { to } },
    changed: changed.length > 0 ? changed : [score.id],
  };
}

// ---------------------------------------------------------------------------
// section.set, section.rm
// ---------------------------------------------------------------------------

/**
 * Upsert the section that begins on a bar (V7, ADR-0021). An upsert like `chord.set`: a bar begins
 * at most one section, so setting one replaces the section already starting there — keeping its id
 * — rather than stacking a second. The target is a whole-bar address (`bar5`), resolved by
 * `resolveBar`, so a rehearsal letter attaches to a *bar number* and survives notes being inserted
 * before it — bar numbers do not shift when a bar's contents change.
 *
 * `letter` and `name` are stored verbatim (trimmed). Omitting one on an upsert keeps the section's
 * existing value; passing `null` clears it. Nothing here is recorded but the id — a section carries
 * no derived state, and `startBar` is the target the log already holds.
 *
 * Sections do not touch rhythm, so no bar is reflagged. They live in `score.sections`, kept in
 * start-bar order so readers (layout's line breaker, `sectionStartingAt`) see them the way a chart
 * is read.
 */
function setSection(score: Score, target: string, payload: SectionSetPayload): Applied {
  const bar = resolveBar(score, target);
  const existing = sectionStartingAt(score, bar.number);
  const id = existing?.id ?? nextId(score, 'section');

  const section = makeSection({
    id,
    startBar: bar.number,
    letter: payload.letter === undefined ? (existing?.letter ?? null) : validLabel(payload.letter, 'letter'),
    name: payload.name === undefined ? (existing?.name ?? null) : validLabel(payload.name, 'name'),
  });

  const sections = [...score.sections.filter((other) => other.id !== id), section].sort(
    (a, b) => a.startBar - b.startBar,
  );

  return {
    score: { ...score, sections },
    operation: { type: 'section.set', target, payload: { ...payload, id } },
    changed: [id],
  };
}

function removeSection(score: Score, target: string): Applied {
  const bar = resolveBar(score, target);
  const existing = sectionStartingAt(score, bar.number);
  if (existing === null) {
    throw new OperationError({
      kind: 'validation',
      detail: `bar ${bar.number} begins no section, so there is nothing to remove`,
    });
  }

  return {
    score: { ...score, sections: score.sections.filter((other) => other.id !== existing.id) },
    operation: { type: 'section.rm', target },
    changed: [existing.id],
  };
}

// ---------------------------------------------------------------------------
// barline.set, ending.set, ending.rm
// ---------------------------------------------------------------------------

const START_BARLINES: readonly StartBarline[] = ['none', 'repeat-start'];
const END_BARLINES: readonly EndBarline[] = ['single', 'double', 'final', 'repeat-end'];
const ENDING_ROLES: readonly EndingRole[] = ['start', 'continue', 'stop', 'start-stop'];

/**
 * Set a bar's opening and/or closing barline (V7, ADR-0021). Barline type is hand-set, never
 * detected (D48), and this is where it is set — a double bar to close a section, a `repeat-start` /
 * `repeat-end` pair around one. At least one of `start`/`end` must be given; a set that changes
 * neither is refused rather than logged as a no-op. Barlines do not touch rhythm, so `mapBar`'s
 * reflag is a harmless write-through — kept for the invariant that every bar rewrite reflags.
 */
function setBarline(score: Score, target: string, payload: BarlineSetPayload): Applied {
  const bar = resolveBar(score, target);
  if (payload.start === undefined && payload.end === undefined) {
    throw new OperationError({
      kind: 'validation',
      detail: 'barline.set needs a --start or an --end (or both); it changed nothing',
    });
  }
  const start = payload.start === undefined ? bar.startBarline : validStartBarline(payload.start);
  const end = payload.end === undefined ? bar.endBarline : validEndBarline(payload.end);

  return {
    score: mapBar(score, bar.id, (b) => ({ ...b, startBarline: start, endBarline: end })),
    operation: { type: 'barline.set', target, payload },
    changed: [bar.id],
  };
}

/**
 * Set a bar's 1st/2nd-ending bracket (V7, ADR-0021). A multi-bar ending is one `start`, any number
 * of `continue`, and one `stop`, each set on its own bar — the model carries the bracket as a field
 * per bar and the engraver draws it that way, so the op stays per bar rather than inventing a span.
 */
function setEnding(score: Score, target: string, payload: EndingSetPayload): Applied {
  const bar = resolveBar(score, target);
  const ending = validEnding(payload);

  return {
    score: mapBar(score, bar.id, (b) => ({ ...b, ending })),
    operation: { type: 'ending.set', target, payload },
    changed: [bar.id],
  };
}

function removeEnding(score: Score, target: string): Applied {
  const bar = resolveBar(score, target);
  if (bar.ending === null) {
    throw new OperationError({
      kind: 'validation',
      detail: `bar ${bar.number} carries no ending, so there is nothing to remove`,
    });
  }

  return {
    score: mapBar(score, bar.id, (b) => ({ ...b, ending: null })),
    operation: { type: 'ending.rm', target },
    changed: [bar.id],
  };
}

function validStartBarline(value: unknown): StartBarline {
  if (typeof value !== 'string' || !START_BARLINES.includes(value as StartBarline)) {
    throw new OperationError({
      kind: 'validation',
      detail: `an opening barline is one of ${START_BARLINES.join(', ')}, not ${JSON.stringify(value)}`,
    });
  }
  return value as StartBarline;
}

function validEndBarline(value: unknown): EndBarline {
  if (typeof value !== 'string' || !END_BARLINES.includes(value as EndBarline)) {
    throw new OperationError({
      kind: 'validation',
      detail: `a closing barline is one of ${END_BARLINES.join(', ')}, not ${JSON.stringify(value)}`,
    });
  }
  return value as EndBarline;
}

function validEnding(payload: EndingSetPayload): Ending {
  const { numbers, role } = payload;
  if (
    !Array.isArray(numbers) ||
    numbers.length === 0 ||
    !numbers.every((n) => Number.isInteger(n) && n >= 1)
  ) {
    throw new OperationError({
      kind: 'validation',
      detail: 'an ending covers one or more pass numbers, e.g. --numbers 1 or --numbers 1,2',
    });
  }
  if (typeof role !== 'string' || !ENDING_ROLES.includes(role as EndingRole)) {
    throw new OperationError({
      kind: 'validation',
      detail: `an ending role is one of ${ENDING_ROLES.join(', ')}, not ${JSON.stringify(role)}`,
    });
  }
  // Normalise the numbers: sorted and de-duplicated, so `2,1` and `1,1,2` both store as `[1, 2]`.
  const unique = [...new Set(numbers)].sort((a, b) => a - b);
  return { numbers: unique, role: role as EndingRole };
}

/**
 * A rehearsal letter or section name, stored verbatim like chord text. A blank string is not a
 * label — it is `null` (cleared) — so a caller cannot store an invisible section marker. Anything
 * non-blank is kept as typed; the model judges nothing about what a letter "should" be (ADR-0021).
 */
function validLabel(value: unknown, field: 'letter' | 'name'): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new OperationError({ kind: 'validation', detail: `a section ${field} is text or null` });
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function validChordText(text: unknown): string {
  if (typeof text !== 'string') {
    throw new OperationError({ kind: 'validation', detail: 'a chord needs text' });
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new OperationError({
      kind: 'validation',
      detail: 'a chord needs non-empty text; remove the chord with chord rm instead',
    });
  }
  return trimmed;
}

/**
 * A chord's review flag, from the grammar (ADR-0012). Parseable text — including `N.C.` — is not
 * flagged; text the grammar cannot read is flagged `unparsed-chord`, which is the projection's `!`
 * and the score rail's highlight. This is a *stored* flag, not a derived one, because the model is
 * framework-free and cannot depend on `@sibei/music` — the applier is where the two meet (see
 * `review.ts` on why unparsed-chord is stored rather than recomputed by every reader).
 */
function chordReview(text: string): Review {
  return parseChord(text) === null ? { flagged: true, reasons: ['unparsed-chord'] } : noReview();
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
 * The rule itself is `barReview` in `@sibei/model`, not a second copy of it here. That matters
 * because as of KAN-597 the model **derives** this reason at read time in every consumer, and the
 * stored copy this function writes is a write-through cache rather than the authority. Two
 * implementations of one rule is how the authority and the cache came to disagree in the first
 * place; borrowing the model's means the stored copy can only ever be out of date, never wrong in
 * principle. Dropping the stored copy altogether is a document shape change owing a migration and a
 * fixture (ADR-0028), so it is booked separately.
 *
 * Only the derivable reason is touched, which is `barReview`'s guarantee: v0.2 sets
 * `low-confidence` and friends from the import pipeline, and a rhythm edit has no business
 * clearing those.
 */
function reflag(bar: Bar, time: TimeSignature): Bar {
  return { ...bar, review: barReview(bar, time) };
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

/** Replay: fold a whole log of *content* operations from nothing (ADR-0003's undo mechanism). */
export function replay(operations: readonly Operation[]): Score | null {
  let score: Score | null = null;
  for (const [index, operation] of operations.entries()) {
    score = applyOperation(score, operation, index).score;
  }
  return score;
}

/**
 * The undo/redo state a log resolves to (V8a).
 *
 * A log is a sequence of batches (grouped by the `batch` column). Most are content edits; some are
 * `undo`/`redo` control markers (ADR-0003, `operations.ts`). Walking the log builds two stacks: the
 * content batches currently *in effect*, and the ones an `undo` set aside for a `redo` to bring
 * back. This is the whole of what undo means — it is derived from the append-only log, never stored
 * as a cursor, which is why undo owes no schema change.
 */
export interface UndoState {
  /** Content batches in effect, oldest first. Folding these flat is the current document. */
  applied: Operation[][];
  /** Content batches an `undo` set aside, in the order a `redo` would bring them back (LIFO). */
  redo: Operation[][];
}

/** Group a seq-ordered log into its batches. A control op is always its own batch of one. */
function batchesOf(log: readonly StoredOperation[]): LoggedOperation[][] {
  const batches: LoggedOperation[][] = [];
  let currentBatch: number | null = null;
  for (const entry of log) {
    if (currentBatch !== entry.batch) {
      currentBatch = entry.batch;
      batches.push([]);
    }
    batches[batches.length - 1]!.push(entry.operation);
  }
  return batches;
}

/**
 * Resolve a log's undo/redo markers to the content batches in effect (V8a).
 *
 * An `undo` pops the most recent applied batch onto the redo stack; a `redo` brings one back; any
 * other batch is a content edit, which is applied and clears the redo stack (a fresh edit after an
 * undo is what discards the redo future — standard undo semantics, and here it falls out of log
 * order rather than being a rule to remember). A marker with nothing to act on is a no-op the
 * applier would never have written, tolerated here so replay stays total over any log.
 */
export function resolveLog(log: readonly StoredOperation[]): UndoState {
  const applied: Operation[][] = [];
  const redo: Operation[][] = [];
  for (const batch of batchesOf(log)) {
    const control = batch.length === 1 && isControlOperation(batch[0]!) ? batch[0].type : null;
    if (control === 'undo') {
      const popped = applied.pop();
      if (popped !== undefined) redo.push(popped);
    } else if (control === 'redo') {
      const brought = redo.pop();
      if (brought !== undefined) applied.push(brought);
    } else {
      // A content batch: control ops are always singletons, so nothing here is one.
      applied.push(batch as Operation[]);
      redo.length = 0;
    }
  }
  return { applied, redo };
}

/** The content operations a log resolves to, once its undo/redo markers are applied. */
export function effectiveLog(log: readonly StoredOperation[]): Operation[] {
  return resolveLog(log).applied.flat();
}

/**
 * Replay a whole stored log — control markers and all — from nothing (V8a).
 *
 * This is the ADR-0003 property in its true form: **replaying a score's append-only log reproduces
 * its stored document exactly, undo and redo included.** `replay` folds content ops; this resolves
 * the markers first, so the two agree on a log with no markers and this one is the one to assert a
 * real log against.
 */
export function replayLog(log: readonly StoredOperation[]): Score | null {
  return replay(effectiveLog(log));
}

/** The document schema every applied score is written at. */
export const APPLIED_SCHEMA_VERSION = SCHEMA_VERSION;

/** Exported for the flag test: a bar with no reasons is not flagged. */
export const emptyReview = noReview;
