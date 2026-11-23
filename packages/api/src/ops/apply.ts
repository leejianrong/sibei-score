import {
  ARTICULATIONS,
  GRACE_VALUES,
  CHORD_STYLE_PRESETS,
  DEFAULT_KEY,
  DEFAULT_TIME,
  FOOTER_PAGES,
  MAX_TEMPO,
  MIN_TEMPO,
  TEMPO_UNITS,
  LINE_BREAKS,
  MAX_BARS_PER_SYSTEM,
  MIN_BARS_PER_SYSTEM,
  SIGNATURE_POLICIES,
  OCTAVE_SHIFTS,
  SPANNER_PLACEMENTS,
  orderedItems,
  MAX_FOOTER_LENGTH,
  SCHEMA_VERSION,
  makeBar,
  makeAnnotation,
  makeChord,
  makeNote,
  makeRest,
  makeScore,
  makeSection,
  nextId,
  noReview,
  parseAddress,
  parsePitch,
  resolveAddress,
  resolveBar,
  resolvePosition,
  sectionStartingAt,
  keyInterval,
  transposePitch,
  AddressError,
  durationTicks,
  itemTicks,
  tupletOf,
  allBarViews,
  barHoldsNotation,
  barViews,
  mapBarView,
  voiceSelects,
  migrateDocument,
  withBarViews,
} from '@sibei/model';
import type {
  VoiceSelect,
  AccidentalDisplay,
  Annotation,
  Articulation,
  GraceNote,
  GraceValue,
  Bar,
  BarView,
  BarItem,
  Chord,
  Duration,
  EndBarline,
  Ending,
  EndingRole,
  ChordStylePreset,
  Id,
  KeySignature,
  Note,
  PageFooter,
  Review,
  Score,
  SignaturePolicy,
  Spanner,
  Tempo,
  StartBarline,
  TieRole,
  TimeSignature,
  Tuplet,
} from '@sibei/model';
import { parseChord, transposeChordText } from '@sibei/music';
import { OperationError } from './errors.js';
import { addPart, addStaff, addVoice, removePart, removeStaff, removeVoice, setClef, setInstrument } from './structure-ops.js';
import { isControlOperation } from './operations.js';
import type {
  ChordSetPayload,
  TextSetPayload,
  TupletSetPayload,
  MetaSetPayload,
  NoteAddPayload,
  BarAddPayload,
  BarlineSetPayload,
  BreakSetPayload,
  EndingSetPayload,
  LoggedOperation,
  NoteSetPayload,
  GraceAddPayload,
  Operation,
  RestAddPayload,
  ScoreCreatePayload,
  ScoreImportPayload,
  SectionSetPayload,
  OttavaSetPayload,
  SlurSetPayload,
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
    case 'text.set':
      return setText(score, operation.target, operation.payload);
    case 'text.rm':
      return removeText(score, operation.target);
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
    case 'tuplet.set':
      return setTuplet(score, operation.target, operation.payload);
    case 'tuplet.rm':
      return removeTuplet(score, operation.target);
    case 'break.set':
      return setBreak(score, operation.target, operation.payload ?? {});
    case 'break.rm':
      return removeBreak(score, operation.target);
    case 'fermata.set':
      return setFermata(score, operation.target, true);
    case 'fermata.rm':
      return setFermata(score, operation.target, false);
    case 'slur.set':
      return setSlur(score, operation.target, operation.payload);
    case 'slur.rm':
      return removeSlur(score, operation.target);
    case 'ottava.set':
      return setOttava(score, operation.target, operation.payload);
    case 'ottava.rm':
      return removeOttava(score, operation.target);
    case 'grace.add':
      return addGrace(score, operation.target, operation.payload);
    case 'grace.rm':
      return removeGrace(score, operation.target);
    case 'bar.add':
      return addBars(score, operation.target, operation.payload ?? {});
    case 'bar.rm':
      return removeBar(score, operation.target);
    case 'part.add':
      return addPart(score, operation.payload);
    case 'part.rm':
      return removePart(score, operation.target, operation.payload);
    case 'staff.add':
      return addStaff(score, operation.target, operation.payload);
    case 'staff.rm':
      return removeStaff(score, operation.target, operation.payload);
    case 'voice.add':
      return addVoice(score, operation.target, operation.payload);
    case 'voice.rm':
      return removeVoice(score, operation.target, operation.payload);
    case 'clef.set':
      return setClef(score, operation.target, operation.payload);
    case 'instrument.set':
      return setInstrument(score, operation.target, operation.payload);
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
  // An old log's `score.import` carries the document in the shape of its day (ADR-0028: old operation shapes stay
  // readable forever). The payload is logged exactly as given; only the score it folds to is brought current.
  const current = document.schemaVersion < SCHEMA_VERSION ? migrateDocument(document).score : document;
  return {
    score: structuredClone(current),
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

  const footer = nextFooter(score, payload);
  const subtitle = nextCredit(score.meta.subtitle, payload.subtitle, 'subtitle');
  const arranger = nextCredit(score.meta.arranger, payload.arranger, 'arranger');
  const policy = nextSignaturePolicy(score, payload);
  const chordStyle = nextChordStyle(score, payload);
  const perSystem = nextBarsPerSystem(score, payload);
  const tempo = nextTempo(score, payload);
  const {
    footer: _footer,
    subtitle: _subtitle,
    arranger: _arranger,
    signaturePolicy: _policy,
    chordStyle: _style,
    barsPerSystem: _bars,
    tempo: _tempo,
    ...rest
  } = score.meta;
  const next: Score = {
    ...score,
    meta: {
      ...rest,
      title: payload.title ?? score.meta.title,
      ...(subtitle === undefined ? {} : { subtitle }),
      composer: payload.composer ?? score.meta.composer,
      ...(arranger === undefined ? {} : { arranger }),
      style: payload.style === undefined ? score.meta.style : payload.style,
      key,
      time,
      ...(footer === undefined ? {} : { footer }),
      ...(policy === undefined ? {} : { signaturePolicy: policy }),
      ...(chordStyle === undefined ? {} : { chordStyle }),
      ...(perSystem === undefined ? {} : { barsPerSystem: perSystem }),
      ...(tempo === undefined ? {} : { tempo }),
    },
  };

  // Changing the meter used to mean recomputing every bar's stored metric-validity flag; since
  // KAN-610 that flag is not stored at all, so a reader derives it fresh from the new
  // `score.meta.time` and there is nothing here for a meter change to update. reflagAllBars still
  // runs, the same invariant-preserving pass every bar rewrite gets, so a bar's stored review can
  // never end up carrying the one reason the applier promises never to write.
  return {
    score: reflagAllBars(next),
    operation: { type: 'meta.set', payload },
    changed: [score.id],
  };
}

/** The signature policy after a `meta.set` (SIB2-173). `every` is stored as absent, so there is one way to say it. */
function nextSignaturePolicy(score: Score, payload: MetaSetPayload): SignaturePolicy | undefined {
  const asked = payload.signaturePolicy;
  if (asked === undefined) return score.meta.signaturePolicy;
  if (!SIGNATURE_POLICIES.includes(asked)) {
    throw new OperationError({
      kind: 'validation',
      detail: `signaturePolicy must be ${SIGNATURE_POLICIES.join(', ')}, not ${JSON.stringify(asked)}`,
    });
  }
  return asked === 'every' ? undefined : asked;
}

/** The tempo mark after a `meta.set` (SIB2-177): untouched unless named; null removes it. */
function nextTempo(score: Score, payload: MetaSetPayload): Tempo | undefined {
  const asked = payload.tempo;
  if (asked === undefined) return score.meta.tempo;
  if (asked === null) return undefined;
  const value = asked.unit?.value;
  const dots = asked.unit?.dots ?? 0;
  if (!(TEMPO_UNITS as readonly unknown[]).includes(value) || (dots !== 0 && dots !== 1)) {
    throw new OperationError({
      kind: 'validation',
      detail: 'tempo unit must be a whole, half, quarter or eighth note, optionally dotted',
    });
  }
  if (!Number.isInteger(asked.bpm) || asked.bpm < MIN_TEMPO || asked.bpm > MAX_TEMPO) {
    throw new OperationError({
      kind: 'validation',
      detail: `tempo must be a whole number from ${MIN_TEMPO} to ${MAX_TEMPO} beats per minute`,
    });
  }
  return { unit: { value: value as Tempo['unit']['value'], dots: dots as 0 | 1 }, bpm: asked.bpm };
}

/** Bars per line after a `meta.set` (SIB2-174): 1 to 8; 4, the grid, is stored as absent. */
function nextBarsPerSystem(score: Score, payload: MetaSetPayload): number | undefined {
  const asked = payload.barsPerSystem;
  if (asked === undefined) return score.meta.barsPerSystem;
  if (asked === null || asked === 4) return undefined;
  if (!Number.isInteger(asked) || asked < MIN_BARS_PER_SYSTEM || asked > MAX_BARS_PER_SYSTEM) {
    throw new OperationError({
      kind: 'validation',
      detail: `barsPerSystem must be a whole number from ${MIN_BARS_PER_SYSTEM} to ${MAX_BARS_PER_SYSTEM}, not ${JSON.stringify(asked)}`,
    });
  }
  return asked;
}

/** The chord style after a `meta.set` (SIB2-163): untouched unless named; `standard` or null clears it. */
function nextChordStyle(score: Score, payload: MetaSetPayload): ChordStylePreset | undefined {
  const named = payload.chordStyle;
  if (named === undefined) return score.meta.chordStyle;
  if (named === null || named === 'standard') return undefined;
  if (!CHORD_STYLE_PRESETS.includes(named)) {
    throw new OperationError({
      kind: 'validation',
      detail: `chordStyle must be ${CHORD_STYLE_PRESETS.join(', ')}, not ${JSON.stringify(named)}`,
    });
  }
  return named;
}

/** A title-block line after a `meta.set` (SIB2-180): untouched unless named; empty text or null removes it. */
function nextCredit(current: string | undefined, next: string | null | undefined, name: string): string | undefined {
  if (next === undefined) return current;
  if (next === null) return undefined;
  if (typeof next !== 'string' || next.length > 200) {
    throw new OperationError({ kind: 'validation', detail: `${name} must be text of at most 200 characters` });
  }
  return next.trim() === '' ? undefined : next;
}

/**
 * The footer after a `meta.set` (SIB2-172): untouched unless the payload names it. Empty text or null
 * removes it; `footerPages` alone re-targets an existing one and is refused with none to place.
 */
function nextFooter(score: Score, payload: MetaSetPayload): PageFooter | undefined {
  const pages = payload.footerPages;
  if (pages !== undefined && !FOOTER_PAGES.includes(pages)) {
    throw new OperationError({
      kind: 'validation',
      detail: `footerPages must be ${FOOTER_PAGES.join(', ')}, not ${JSON.stringify(pages)}`,
    });
  }
  const current = score.meta.footer;
  if (payload.footer === undefined) {
    if (pages === undefined) return current;
    if (current === undefined) {
      throw new OperationError({ kind: 'validation', detail: 'footerPages needs a footer: set one with footer' });
    }
    return { ...current, pages };
  }
  if (payload.footer === null) return undefined;
  if (typeof payload.footer !== 'string' || payload.footer.length > MAX_FOOTER_LENGTH) {
    throw new OperationError({
      kind: 'validation',
      detail: `footer must be text of at most ${MAX_FOOTER_LENGTH} characters`,
    });
  }
  if (payload.footer.trim() === '') return undefined;
  return { text: payload.footer, pages: pages ?? current?.pages ?? 'all' };
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
    ...(payload.accidental === undefined ? {} : { accidental: validAccidental(payload.accidental) }),
    ...(payload.tie === undefined ? {} : { tie: validTie(payload.tie) }),
    ...(payload.spellingPinned === undefined ? {} : { spellingPinned: validPinned(payload.spellingPinned) }),
  });
  const marks = payload.articulations === undefined ? [] : validArticulations(payload.articulations);
  if (marks.length > 0) note.articulations = marks;

  return {
    score: withItemAdded(score, position.bar.id, note, position.select),
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
    score: withItemAdded(score, position.bar.id, rest, position.select),
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
function refuseOccupiedOnset(bar: BarView, onset: number, target: string): void {
  const existing = bar.items.find((item) => item.onset === onset);
  if (existing === undefined) return;
  throw new OperationError({
    kind: 'validation',
    detail:
      `${target} already has a ${existing.kind} on it (${existing.id}). A voice carries one item per onset, ` +
      `so set or remove that one, or write the other line in another voice (voice add).`,
  });
}

/** Items are kept in onset order, which `Bar.items` documents and addressing relies on. */
function withItemAdded(score: Score, barId: Id, item: BarItem, select: VoiceSelect): Score {
  return mapBar(score, barId, (bar) => ({
    ...bar,
    items: [...bar.items, item].sort((a, b) => a.onset - b.onset),
  }), select);
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
    ...(payload.accidental === undefined ? {} : { accidental: validAccidental(payload.accidental) }),
    ...(payload.tie === undefined ? {} : { tie: validTie(payload.tie) }),
    ...(payload.spellingPinned === undefined ? {} : { spellingPinned: validPinned(payload.spellingPinned) }),
  };

  if (payload.articulations !== undefined) {
    const marks = validArticulations(payload.articulations);
    if (marks.length > 0) updated.articulations = marks;
    else delete updated.articulations;
  }

  return {
    score: mapBar(score, resolved.bar.id, (bar) => ({
      ...bar,
      items: bar.items.map((item) => (item.id === note.id ? updated : item)),
    }), resolved.select),
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
  // A slur names its notes by id, so removing either end takes the slur with it (SIB2-167).
  const without = withoutSlursOn(score, id);
  return {
    score: mapBar(without, resolved.bar.id, (bar) => ({
      ...bar,
      items: bar.items.filter((item) => item.id !== id),
      tuplets: bar.tuplets
        .map((tuplet) => ({ ...tuplet, memberIds: tuplet.memberIds.filter((m) => m !== id) }))
        .filter((tuplet) => tuplet.memberIds.length > 0),
    }), resolved.select),
    operation: kind === 'note' ? { type: 'note.rm', target } : { type: 'rest.rm', target },
    changed: [id],
  };
}

// ---------------------------------------------------------------------------
// tuplet.set, tuplet.rm
// ---------------------------------------------------------------------------

/** Re-lay a bar's items after a tuplet change: `memberIds` back to back from the first, later items shifted by the delta. */
function relayRun(bar: BarView, memberIds: readonly Id[], tuplets: Tuplet[]): BarView {
  const probe: BarView = { ...bar, tuplets };
  const members = bar.items.filter((item) => memberIds.includes(item.id)).sort((a, b) => a.onset - b.onset);
  const first = members[0] as BarItem;
  const last = members[members.length - 1] as BarItem;
  const oldEnd = last.onset + itemTicks(last, bar);
  let cursor = first.onset;
  const moved = new Map<Id, number>();
  for (const member of members) {
    moved.set(member.id, cursor);
    cursor += itemTicks(member, probe);
  }
  const delta = cursor - oldEnd;
  return {
    ...bar,
    tuplets,
    items: bar.items.map((item) => {
      const onset = moved.get(item.id);
      if (onset !== undefined) return { ...item, onset };
      return item.onset >= oldEnd ? { ...item, onset: item.onset + delta } : item;
    }),
  };
}

function validTupletNumber(value: unknown, field: 'actual' | 'normal'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 32) {
    throw new OperationError({
      kind: 'validation',
      detail: `tuplet ${field} is a whole number from 1 to 32, e.g. actual 3 in normal 2 for a triplet`,
    });
  }
  return value;
}

function setTuplet(score: Score, target: string, payload: TupletSetPayload): Applied {
  const actual = validTupletNumber(payload.actual, 'actual');
  const normal = validTupletNumber(payload.normal, 'normal');
  if (actual < 2 || actual === normal) {
    throw new OperationError({
      kind: 'validation',
      detail: 'a tuplet writes at least 2 notes in the time of a different number, e.g. 3 in 2',
    });
  }
  const resolved = resolveAddress(score, target, 'item');
  const bar = resolved.bar;
  const ordered = [...bar.items].sort((a, b) => a.onset - b.onset);
  const from = ordered.findIndex((item) => item.id === resolved.target.id);
  const count = payload.count === undefined ? actual : payload.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
    throw new OperationError({ kind: 'validation', detail: 'a tuplet spans a whole number of items' });
  }
  const members = ordered.slice(from, from + count);
  if (members.length < count) {
    throw new OperationError({
      kind: 'validation',
      detail: `${target} has only ${members.length} item${members.length === 1 ? '' : 's'} from there to the end of bar ${bar.number}, not ${count}`,
    });
  }
  const nested = members.find((item) => tupletOf(item.id, bar) !== null);
  if (nested !== undefined) {
    throw new OperationError({
      kind: 'validation',
      detail: `${nested.id} is already in a tuplet; remove that one first (tuplets do not nest)`,
    });
  }
  const fractional = members.find((item) => (durationTicks(item.duration) * normal) % actual !== 0);
  if (fractional !== undefined) {
    throw new OperationError({
      kind: 'validation',
      detail: `${actual} in ${normal} would put ${fractional.id} on a fractional tick; use shorter or longer note values`,
    });
  }

  const id = payload.id ?? nextId(score, 'tuplet');
  const tuplet: Tuplet = { id, actual, normal, memberIds: members.map((m) => m.id) };
  return {
    score: mapBar(score, bar.id, (b) => relayRun(b, tuplet.memberIds, [...b.tuplets, tuplet]), resolved.select),
    operation: { type: 'tuplet.set', target, payload: { ...payload, count, id } },
    changed: [id, ...tuplet.memberIds],
  };
}

function removeTuplet(score: Score, target: string): Applied {
  const resolved = resolveAddress(score, target, 'item');
  const tuplet = tupletOf(resolved.target.id, resolved.bar);
  if (tuplet === null) {
    throw new OperationError({
      kind: 'validation',
      detail: `${target} is not in a tuplet, so there is nothing to remove`,
    });
  }
  return {
    score: mapBar(
      score,
      resolved.bar.id,
      (b) =>
        relayRun(
          b,
          tuplet.memberIds,
          b.tuplets.filter((t) => t.id !== tuplet.id),
        ),
      resolved.select,
    ),
    operation: { type: 'tuplet.rm', target },
    changed: [tuplet.id, ...tuplet.memberIds],
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
  const position = resolvePosition(score, target, 'harmony');
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
// text.set, text.rm (SIB2-169)
// ---------------------------------------------------------------------------

/**
 * Upsert the text direction at a beat. A direction is an `Annotation`, the free text the model
 * already has beside chords; one per beat, so setting again edits it in place and keeps its id.
 * Written by hand it is never flagged — only an import's guesses are.
 */
function setText(score: Score, target: string, payload: TextSetPayload): Applied {
  const position = resolvePosition(score, target, 'harmony');
  if (typeof payload.text !== 'string' || payload.text.trim() === '') {
    throw new OperationError({
      kind: 'validation',
      detail: 'a text direction needs non-empty text; remove it with text rm instead',
    });
  }
  const text = payload.text.trim();
  const existing = position.bar.annotations.find((annotation) => annotation.onset === position.onset);
  const id = existing?.id ?? payload.id ?? nextId(score, 'annotation');
  const lineEndBarId = nextLineEnd(score, position.bar, existing, payload);
  const annotation = {
    ...makeAnnotation({ id, onset: position.onset, text }),
    ...(lineEndBarId === undefined ? {} : { lineEndBarId }),
  };
  return {
    score: mapBar(score, position.bar.id, (bar) => ({
      ...bar,
      annotations: [...bar.annotations.filter((other) => other.id !== id), annotation].sort(
        (a, b) => a.onset - b.onset,
      ),
    })),
    operation: { type: 'text.set', target, payload: { ...payload, text, id } },
    changed: [id],
  };
}

/** The bar a direction's dashed line ends on after a `text.set` (SIB2-170): kept unless `until` says otherwise. */
function nextLineEnd(
  score: Score,
  start: BarView,
  existing: Annotation | undefined,
  payload: TextSetPayload,
): Id | undefined {
  if (payload.until === undefined) return existing?.lineEndBarId;
  if (payload.until === null) return undefined;
  if (typeof payload.until !== 'string') {
    throw new OperationError({ kind: 'validation', detail: 'until must be a bar address such as bar8, or null' });
  }
  const end = resolveBar(score, payload.until);
  if (end.number < start.number) {
    throw new OperationError({
      kind: 'validation',
      detail: `the line cannot end at bar ${end.number}, before the direction's own bar ${start.number}`,
    });
  }
  return end.id;
}

/** Remove a direction by its id (`annotation-3`, which `show` prints) or by the beat it sits on. */
function removeText(score: Score, target: string): Applied {
  const address = parseAddress(target);
  let found: { bar: BarView; annotation: Annotation } | null = null;
  if (address.form === 'id') {
    for (const bar of barViews(score)) {
      const annotation = bar.annotations.find((candidate) => candidate.id === address.id);
      if (annotation !== undefined) found = { bar, annotation };
    }
  } else if (address.form === 'beat') {
    const position = resolvePosition(score, address, 'harmony');
    const annotation = position.bar.annotations.find((candidate) => candidate.onset === position.onset);
    if (annotation !== undefined) found = { bar: position.bar, annotation };
  }
  if (found === null) {
    throw new OperationError({
      kind: 'validation',
      detail: `there is no text direction at ${target}; name one by its id or its bar and beat, as in bar4.beat1`,
    });
  }
  const { bar: owner, annotation } = found;
  return {
    score: mapBar(score, owner.id, (bar) => ({
      ...bar,
      annotations: bar.annotations.filter((other) => other.id !== annotation.id),
    })),
    operation: { type: 'text.rm', target },
    changed: [annotation.id],
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
 * Rhythm is untouched, and since KAN-610 there is no stored metric-validity flag left to fall out
 * of step in the first place — but the bars are reflagged anyway, the same no-op `meta.set`
 * performs, so a bar's stored review can never end up carrying the one reason the applier promises
 * never to write.
 */
function transpose(score: Score, payload: TransposePayload): Applied {
  const to = validKey(payload.to);
  const interval = keyInterval(score.meta.key, to);
  const changed: Id[] = [];

  // Every staff and voice moves (ADR-0041); the chord symbols are one lane, so the first pass carries them.
  let next: Score = { ...score, meta: { ...score.meta, key: to } };
  const selects: VoiceSelect[] = voiceSelects(score);
  (selects.length === 0 ? [{}] : selects).forEach((select, pass) => {
    const views = barViews(next, select).map((bar) => {
      const items = bar.items.map((item) => {
        if (item.kind !== 'note') return item;
        changed.push(item.id);
        const graces =
          item.graces === undefined
            ? {}
            : { graces: item.graces.map((grace) => ({ ...grace, pitch: transposePitch(grace.pitch, interval, to, false) })) };
        return { ...item, pitch: transposePitch(item.pitch, interval, to, item.spellingPinned), ...graces };
      });
      const chords =
        pass > 0
          ? bar.chords
          : bar.chords.map((chord) => {
              const moved = transposeChordText(chord.text, interval, to, chord.spellingPinned);
              if (moved === chord.text) return chord;
              changed.push(chord.id);
              return { ...chord, text: moved };
            });
      return reflag({ ...bar, items, chords });
    });
    next = withBarViews(next, views, select);
  });
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

// ---------------------------------------------------------------------------
// fermata.set, fermata.rm (SIB2-183)
// ---------------------------------------------------------------------------

/** Put a fermata on a note or rest, or take it off. Absent is the off state, never `fermata: false`. */
function setFermata(score: Score, target: string, on: boolean): Applied {
  const resolved = resolveAddress(score, target, 'item');
  const item = resolved.target as BarItem;
  if (!on && item.fermata !== true) {
    throw new OperationError({
      kind: 'validation',
      detail: `${target} has no fermata, so there is nothing to remove`,
    });
  }
  const updated: BarItem = on ? { ...item, fermata: true } : withoutFermata(item);
  return {
    score: mapBar(score, resolved.bar.id, (bar) => ({
      ...bar,
      items: bar.items.map((other) => (other.id === item.id ? updated : other)),
    }), resolved.select),
    operation: { type: on ? 'fermata.set' : 'fermata.rm', target },
    changed: [item.id],
  };
}

function withoutFermata(item: BarItem): BarItem {
  const { fermata: _gone, ...rest } = item;
  return rest as BarItem;
}

// ---------------------------------------------------------------------------
// grace.add, grace.rm (SIB2-185)
// ---------------------------------------------------------------------------

/** Most grace notes one note carries: past this a run is an ornament written out, not a grace group. */
const MAX_GRACES = 8;

/** Append a grace note to the target note. It is not a bar item, so no bar is reflagged (ADR-0013). */
function addGrace(score: Score, target: string, payload: GraceAddPayload): Applied {
  const resolved = resolveAddress(score, target, 'note');
  const note = resolved.target as Note;
  if ((note.graces?.length ?? 0) >= MAX_GRACES) {
    throw new OperationError({ kind: 'validation', detail: `${target} already has ${MAX_GRACES} grace notes, the most one note carries` });
  }
  const value = payload.value ?? 8;
  if (!GRACE_VALUES.includes(value as GraceValue)) {
    throw new OperationError({
      kind: 'validation',
      detail: `a grace note value is ${GRACE_VALUES.join(', ')}, not ${JSON.stringify(value)}`,
    });
  }
  if (payload.slashed !== undefined && typeof payload.slashed !== 'boolean') {
    throw new OperationError({ kind: 'validation', detail: `slashed is true or false, not ${JSON.stringify(payload.slashed)}` });
  }
  const id = payload.id ?? nextId(score, 'grace');
  const grace: GraceNote = {
    id,
    pitch: validPitch(payload.pitch),
    value: value as GraceValue,
    slashed: payload.slashed ?? false,
    accidental: payload.accidental === undefined ? 'auto' : validAccidental(payload.accidental),
  };
  const updated: Note = { ...note, graces: [...(note.graces ?? []), grace] };
  return {
    score: replaceNote(score, resolved.bar.id, updated, resolved.select),
    operation: { type: 'grace.add', target, payload: { ...payload, id } },
    changed: [id],
  };
}

/** Remove one grace by id, or every grace on a note by its address. Absent is the none state, never `[]`. */
function removeGrace(score: Score, target: string): Applied {
  for (const { select, views } of allBarViews(score)) {
    for (const bar of views) {
      for (const item of bar.items) {
        if (item.kind !== 'note' || item.graces === undefined || !item.graces.some((grace) => grace.id === target)) continue;
        const rest = item.graces.filter((grace) => grace.id !== target);
        return {
          score: replaceNote(score, bar.id, withGraces(item, rest), select),
          operation: { type: 'grace.rm', target },
          changed: [target],
        };
      }
    }
  }
  const resolved = resolveAddress(score, target, 'note');
  const note = resolved.target as Note;
  if (note.graces === undefined || note.graces.length === 0) {
    throw new OperationError({ kind: 'validation', detail: `${target} has no grace notes, so there is nothing to remove` });
  }
  return {
    score: replaceNote(score, resolved.bar.id, withGraces(note, []), resolved.select),
    operation: { type: 'grace.rm', target },
    changed: note.graces.map((grace) => grace.id),
  };
}

function withGraces(note: Note, graces: GraceNote[]): Note {
  const { graces: _gone, ...rest } = note;
  return graces.length === 0 ? rest : { ...rest, graces };
}

function replaceNote(score: Score, barId: Id, updated: Note, select: VoiceSelect): Score {
  return mapBar(score, barId, (bar) => ({
    ...bar,
    items: bar.items.map((item) => (item.id === updated.id ? updated : item)),
  }), select);
}

// ---------------------------------------------------------------------------
// slur.set, slur.rm (SIB2-167)
// ---------------------------------------------------------------------------

function withoutSlursOn(score: Score, noteId: Id): Score {
  const spanners = score.spanners;
  if (spanners === undefined) return score;
  const kept = spanners.filter((spanner) => spanner.startId !== noteId && spanner.endId !== noteId);
  if (kept.length === spanners.length) return score;
  const { spanners: _old, ...rest } = score;
  return kept.length === 0 ? rest : { ...rest, spanners: kept };
}

/** Reading-order index of every item, so "later" means the same on every bar. */
function readingOrder(score: Score): Map<Id, number> {
  const order = new Map<Id, number>();
  // Bar by bar, then staff, then voice: "later" for a spanner across staves (ADR-0041).
  const voices = allBarViews(score);
  score.bars.forEach((_, at) => {
    for (const { views } of voices) for (const item of orderedItems(views[at]!)) order.set(item.id, order.size);
  });
  return order;
}

/**
 * Slur from the target note to `to`. Both must be notes, distinct, and in reading order; a rest cannot
 * carry a slur. Re-setting the same pair is an upsert that keeps the id and changes only the placement.
 */
function setSlur(score: Score, target: string, payload: SlurSetPayload): Applied {
  if (typeof payload.to !== 'string' || payload.to.trim() === '') {
    throw new OperationError({ kind: 'validation', detail: 'a slur needs an end note: slur set <start> <end>' });
  }
  const placement = payload.placement;
  if (placement !== undefined && placement !== 'auto' && !SPANNER_PLACEMENTS.includes(placement)) {
    throw new OperationError({
      kind: 'validation',
      detail: `a slur's placement is ${SPANNER_PLACEMENTS.join(', ')} or auto, not ${JSON.stringify(placement)}`,
    });
  }
  const start = resolveAddress(score, target, 'note').target;
  const end = resolveAddress(score, payload.to, 'note').target;
  const order = readingOrder(score);
  if (start.id === end.id || (order.get(start.id) ?? 0) > (order.get(end.id) ?? 0)) {
    throw new OperationError({
      kind: 'validation',
      detail: `a slur runs from a note to a later one; ${target} to ${payload.to} does not`,
    });
  }
  const spanners = score.spanners ?? [];
  const existing = spanners.find(
    (spanner) => spanner.kind === 'slur' && spanner.startId === start.id && spanner.endId === end.id,
  );
  const id = existing?.id ?? payload.id ?? nextId(score, 'slur');
  const chosen = placement === undefined ? existing?.placement : placement === 'auto' ? undefined : placement;
  const slur: Spanner = {
    id,
    kind: 'slur',
    startId: start.id,
    endId: end.id,
    ...(chosen === undefined ? {} : { placement: chosen }),
  };
  return {
    score: { ...score, spanners: [...spanners.filter((spanner) => spanner.id !== id), slur] },
    operation: { type: 'slur.set', target, payload: { ...payload, id } },
    changed: [id, start.id, end.id],
  };
}

// ---------------------------------------------------------------------------
// ottava.set, ottava.rm (SIB2-184)
// ---------------------------------------------------------------------------

/**
 * An 8va or 8vb line from the target note to `to`, in reading order. The notes keep their sounding pitch; the
 * line only changes how they are drawn. Two ottava lines may not overlap, since a note is shifted by one at most.
 * Re-setting the same pair is an upsert that keeps the id and changes the direction.
 */
function setOttava(score: Score, target: string, payload: OttavaSetPayload): Applied {
  if (typeof payload.to !== 'string' || payload.to.trim() === '') {
    throw new OperationError({ kind: 'validation', detail: 'an ottava needs an end note: ottava set <start> <end> --up|--down' });
  }
  if (!OCTAVE_SHIFTS.includes(payload.shift)) {
    throw new OperationError({
      kind: 'validation',
      detail: `an ottava's shift is ${OCTAVE_SHIFTS.join(' (8va) or ').replace('down', 'down (8vb)')}, not ${JSON.stringify(payload.shift)}`,
    });
  }
  const start = resolveAddress(score, target, 'note').target;
  const end = resolveAddress(score, payload.to, 'note').target;
  const order = readingOrder(score);
  const first = order.get(start.id) ?? 0;
  const last = order.get(end.id) ?? 0;
  if (start.id === end.id || first > last) {
    throw new OperationError({
      kind: 'validation',
      detail: `an ottava runs from a note to a later one; ${target} to ${payload.to} does not`,
    });
  }
  const spanners = score.spanners ?? [];
  const existing = spanners.find(
    (spanner) => spanner.kind === 'ottava' && spanner.startId === start.id && spanner.endId === end.id,
  );
  const id = existing?.id ?? payload.id ?? nextId(score, 'ottava');
  const clash = spanners.find(
    (spanner) =>
      spanner.kind === 'ottava' &&
      spanner.id !== id &&
      (order.get(spanner.startId) ?? 0) <= last &&
      (order.get(spanner.endId) ?? 0) >= first,
  );
  if (clash !== undefined) {
    throw new OperationError({
      kind: 'validation',
      detail: `${clash.id} already covers part of that run; remove it first (ottava rm), lines do not overlap`,
    });
  }
  const ottava: Spanner = { id, kind: 'ottava', startId: start.id, endId: end.id, octaveShift: payload.shift };
  return {
    score: { ...score, spanners: [...spanners.filter((spanner) => spanner.id !== id), ottava] },
    operation: { type: 'ottava.set', target, payload: { ...payload, id } },
    changed: [id, start.id, end.id],
  };
}

function removeOttava(score: Score, target: string): Applied {
  const spanners = score.spanners ?? [];
  const lines = spanners.filter((spanner) => spanner.kind === 'ottava');
  let found: Spanner[] = lines.filter((spanner) => spanner.id === target);
  if (found.length === 0) {
    let noteId: Id | null = null;
    try {
      noteId = resolveAddress(score, target, 'note').target.id;
    } catch {
      noteId = null;
    }
    if (noteId !== null) found = lines.filter((spanner) => spanner.startId === noteId);
  }
  if (found.length !== 1) {
    throw new OperationError({
      kind: 'validation',
      detail: `there is no ottava at ${target}; name one by its id (ottava-1, which show prints) or the note it starts on`,
    });
  }
  const gone = found[0] as Spanner;
  const kept = spanners.filter((spanner) => spanner.id !== gone.id);
  const { spanners: _old, ...rest } = score;
  return {
    score: kept.length === 0 ? rest : { ...rest, spanners: kept },
    operation: { type: 'ottava.rm', target },
    changed: [gone.id],
  };
}

function removeSlur(score: Score, target: string): Applied {
  const spanners = score.spanners ?? [];
  const slurs = spanners.filter((spanner) => spanner.kind === 'slur');
  let found: Spanner[] = slurs.filter((spanner) => spanner.id === target);
  if (found.length === 0) {
    // Not an id: a note address names the slur that starts there.
    let noteId: Id | null = null;
    try {
      noteId = resolveAddress(score, target, 'note').target.id;
    } catch {
      noteId = null;
    }
    if (noteId !== null) found = slurs.filter((spanner) => spanner.startId === noteId);
  }
  if (found.length !== 1) {
    throw new OperationError({
      kind: 'validation',
      detail:
        found.length === 0
          ? `there is no slur at ${target}; name one by its id (slur-1, which show prints) or the note it starts on`
          : `${found.length} slurs start at ${target} (${found.map((s) => s.id).join(', ')}); name one by its id`,
    });
  }
  const gone = found[0] as Spanner;
  const kept = spanners.filter((spanner) => spanner.id !== gone.id);
  const { spanners: _old, ...rest } = score;
  return {
    score: kept.length === 0 ? rest : { ...rest, spanners: kept },
    operation: { type: 'slur.rm', target },
    changed: [gone.id],
  };
}

// ---------------------------------------------------------------------------
// break.set, break.rm (SIB2-174)
// ---------------------------------------------------------------------------

/**
 * Override the four-bar grid on one bar: `after` ends the line after it, `join` lets a bar that begins a
 * section share the previous line. Whole-bar, like the barline and ending ops. `join` on a bar that
 * begins no section would do nothing, so it is refused rather than stored as a silent no-op.
 */
function setBreak(score: Score, target: string, payload: BreakSetPayload): Applied {
  const bar = resolveBar(score, target);
  const kind = payload.kind ?? 'after';
  if (!LINE_BREAKS.includes(kind)) {
    throw new OperationError({
      kind: 'validation',
      detail: `a line break is ${LINE_BREAKS.join(' or ')}, not ${JSON.stringify(kind)}`,
    });
  }
  if (kind === 'join' && sectionStartingAt(score, bar.number) === null) {
    throw new OperationError({
      kind: 'validation',
      detail: `bar ${bar.number} begins no section, so there is no forced break for it to join across`,
    });
  }
  return {
    score: mapBar(score, bar.id, (b) => ({ ...b, lineBreak: kind })),
    operation: { type: 'break.set', target, payload },
    changed: [bar.id],
  };
}

function removeBreak(score: Score, target: string): Applied {
  const bar = resolveBar(score, target);
  if (bar.lineBreak === undefined) {
    throw new OperationError({
      kind: 'validation',
      detail: `bar ${bar.number} has no line-break override, so there is nothing to remove`,
    });
  }
  return {
    score: mapBar(score, bar.id, (b) => {
      const { lineBreak: _gone, ...rest } = b;
      return rest;
    }),
    operation: { type: 'break.rm', target },
    changed: [bar.id],
  };
}

// ---------------------------------------------------------------------------
// bar.add, bar.rm (SIB2-186)
// ---------------------------------------------------------------------------

/**
 * Bars are addressed by number (ADR-0007), so adding or removing one renumbers everything after it,
 * and a section's `startBar` is a bar number too, so it moves with them. Ids never change. Both
 * moves are pure functions of the document and the payload, and the new ids are recorded, so replay
 * (and undo, which is replay) reproduces them exactly.
 */
function shiftBars(
  bars: readonly BarView[],
  sections: Score['sections'],
  after: number,
  by: number,
): { bars: BarView[]; sections: Score['sections'] } {
  return {
    bars: bars.map((bar) => (bar.number > after ? { ...bar, number: bar.number + by } : bar)),
    sections: sections.map((s) => (s.startBar > after ? { ...s, startBar: s.startBar + by } : s)),
  };
}

function addBars(score: Score, target: string | undefined, payload: BarAddPayload): Applied {
  const count = payload.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new OperationError({
      kind: 'validation',
      detail: `bar.add count must be a whole number between 1 and 1000, not ${JSON.stringify(count)}`,
    });
  }
  const after =
    target === undefined
      ? Math.max(0, ...score.bars.map((bar) => bar.number))
      : resolveBar(score, target).number;

  const ids = payload.ids ?? newBarIds(score, count);
  if (ids.length !== count) {
    throw new OperationError({ kind: 'validation', detail: 'bar.add ids must name exactly count bars' });
  }
  const added = ids.map((id, offset) => makeBar({ id, number: after + 1 + offset }));

  const shifted = shiftBars(barViews(score), score.sections, after, count);
  const at = shifted.bars.filter((bar) => bar.number <= after).length;
  const bars = [...shifted.bars.slice(0, at), ...added, ...shifted.bars.slice(at)];

  return {
    score: withBarViews({ ...score, sections: shifted.sections }, bars),
    operation: { type: 'bar.add', ...(target === undefined ? {} : { target }), payload: { ...payload, ids } },
    changed: ids,
  };
}

function newBarIds(score: Score, count: number): Id[] {
  const first = Number(nextId(score, 'bar').slice('bar-'.length));
  return Array.from({ length: count }, (_, offset) => `bar-${first + offset}`);
}

/**
 * Remove an **empty** bar. A bar holding notes, chords or text is refused rather than deleted: the
 * undo is there, but a caller that did not mean to lose music should be told, and `note rm` is
 * already the verb for clearing one. A bar that starts a section is refused for the same reason.
 */
function removeBar(score: Score, target: string): Applied {
  const bar = resolveBar(score, target);
  if (score.bars.length === 1) {
    throw new OperationError({ kind: 'validation', detail: 'a chart needs at least one bar' });
  }
  const holds = [
    barHoldsNotation(score, bar.id) ? 'notes or rests' : null,
    bar.chords.length > 0 ? 'chords' : null,
    bar.annotations.length > 0 ? 'text' : null,
    bar.ending !== null ? 'an ending' : null,
    score.sections.some((s) => s.startBar === bar.number) ? 'a section start' : null,
  ].filter((what): what is string => what !== null);
  if (holds.length > 0) {
    throw new OperationError({
      kind: 'validation',
      detail: `bar ${bar.number} holds ${holds.join(', ')}; clear it first, bar rm only removes an empty bar`,
    });
  }

  // A direction's dashed line that ended on the removed bar loses its end rather than dangling (SIB2-170).
  const remaining = barViews(score)
      .filter((b) => b.id !== bar.id)
      .map((b) =>
        b.annotations.some((a) => a.lineEndBarId === bar.id)
          ? {
              ...b,
              annotations: b.annotations.map((a) => {
                const { lineEndBarId: _end, ...rest } = a;
                return a.lineEndBarId === bar.id ? rest : a;
              }),
            }
          : b,
      );
  const shifted = shiftBars(remaining, score.sections, bar.number, -1);
  return {
    score: withBarViews({ ...score, sections: shifted.sections }, shifted.bars),
    operation: { type: 'bar.rm', target },
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
// Bar rewriting, and its stored review
// ---------------------------------------------------------------------------

/** Rewrite one bar, then normalise its stored review: the derivable reason never survives a rewrite. */
function mapBar(score: Score, barId: Id, change: (bar: BarView) => BarView, select: VoiceSelect = {}): Score {
  return mapBarView(score, barId, (view) => reflag(change(view)), select);
}

function reflagAllBars(score: Score): Score {
  return { ...score, bars: score.bars.map((bar) => reflag(bar)) };
}

/**
 * Metric validity is derived, never an invariant (ADR-0013), and since KAN-610 it is never stored
 * either. `barReview` in `@sibei/model` computes `metrically-invalid` fresh from a bar's contents
 * and `score.meta.time`, and that is now the *only* place the reason exists — every reader has
 * gone through it since KAN-597, so the copy this function used to write into the document was a
 * write-through cache nothing consulted. Dropping it was the document shape change KAN-610 owed a
 * migration for (ADR-0028; see `migrate.ts`'s `DROP_METRICALLY_INVALID` step for documents written
 * before it).
 *
 * What is left to do on a rewrite is narrower: strip a stale `metrically-invalid` if one somehow
 * survives (a migrated document never carries one, so this is normally a no-op) and leave every
 * other stored reason alone. `low-confidence`, `unparsed-chord` and `unrecognised-text` come from
 * the import pipeline and nothing here can recompute them, so a rhythm edit, a key change or a
 * transpose has no business clearing them.
 */
function reflag<T extends Bar>(bar: T): T {
  const reasons = bar.review.reasons.filter((reason) => reason !== 'metrically-invalid');
  return { ...bar, review: { flagged: reasons.length > 0, reasons } };
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

const NOTE_VALUES = [1, 2, 4, 8, 16, 32];

const ACCIDENTAL_DISPLAYS: readonly AccidentalDisplay[] = ['auto', 'show', 'hide', 'parens'];
const TIE_ROLES: readonly TieRole[] = ['none', 'start', 'stop', 'both'];

// These three used to be spread through raw, so `accidental: "cautionary"` was stored and answered
// 200 (KAN-606). The lists are the model's own union members, quoted so a refusal says what works.
/** The marks, checked, deduplicated and put in stacking order so one set of marks is one document (SIB2-179). */
function validArticulations(value: unknown): Articulation[] {
  if (!Array.isArray(value)) {
    throw new OperationError({
      kind: 'validation',
      detail: `articulations is a list of ${ARTICULATIONS.join(', ')}; an empty list clears them`,
    });
  }
  for (const mark of value) {
    if (!ARTICULATIONS.includes(mark as Articulation)) {
      throw new OperationError({
        kind: 'validation',
        detail: `${JSON.stringify(mark)} is not an articulation; use ${ARTICULATIONS.join(', ')}`,
      });
    }
  }
  return ARTICULATIONS.filter((mark) => value.includes(mark));
}

function validAccidental(value: unknown): AccidentalDisplay {
  if (!ACCIDENTAL_DISPLAYS.includes(value as AccidentalDisplay)) {
    throw new OperationError({
      kind: 'validation',
      detail: `${JSON.stringify(value)} is not an accidental display; use one of ${ACCIDENTAL_DISPLAYS.join(', ')}`,
    });
  }
  return value as AccidentalDisplay;
}

function validTie(value: unknown): TieRole {
  if (!TIE_ROLES.includes(value as TieRole)) {
    throw new OperationError({
      kind: 'validation',
      detail: `${JSON.stringify(value)} is not a tie role; use one of ${TIE_ROLES.join(', ')}`,
    });
  }
  return value as TieRole;
}

function validPinned(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new OperationError({
      kind: 'validation',
      detail: `spellingPinned must be true or false, not ${JSON.stringify(value)}`,
    });
  }
  return value;
}

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
