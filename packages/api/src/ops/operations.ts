import type {
  AccidentalDisplay,
  Articulation,
  Clef,
  StaffType,
  Duration,
  EndBarline,
  GraceValue,
  EndingRole,
  Id,
  KeySignature,
  Score,
  OctaveShift,
  SpannerPlacement,
  StartBarline,
  TieRole,
  TimeSignature,
} from '@sibei/model';

/**
 * The operation contract (ADR-0003, PLAN.md). Every mutation is an operation appended to a
 * per-score log and applied by a single applier. Nothing else writes to the store.
 *
 * An operation is `{type, target?, payload, expectedVersion}`. `target` is an address string
 * (ADR-0007) and is absent for operations that address the score rather than something in it.
 *
 * **Operations are versioned independently of the document schema**, and old operation shapes
 * must stay readable *forever* rather than being migrated away, because undo replays them
 * (ADR-0028). That is the one rule to hold on to when editing this file: a field may be added,
 * and a new type may be added, but the meaning of an existing shape may never change. If it
 * has to, it becomes a new type and `OPERATION_VERSION` goes up.
 */

export const OPERATION_VERSION = 1;

/**
 * Fields marked *recorded* are filled in by the applier during normalisation and written to the
 * log. On replay the recorded value wins, which is what makes replay-from-empty exact rather
 * than merely likely: it does not depend on the id policy that was in force when the operation
 * was first applied.
 */

export interface ScoreCreatePayload {
  id: Id;
  title?: string;
  composer?: string;
  style?: string | null;
  key?: KeySignature;
  time?: TimeSignature;
  /** How many numbered bars to open with. Normalisation turns this into `bars`. */
  barCount?: number;
  /** Whether to open bar 0, the pickup (ADR-0007). */
  pickup?: boolean;
  /** *Recorded.* Exactly the bars to create, with their ids. Authoritative on replay. */
  bars?: { id: Id; number: number }[];
}

export interface MetaSetPayload {
  title?: string;
  /** Printed under the title (SIB2-180). Empty or null removes it. */
  subtitle?: string | null;
  /** `\n` makes a second composer line (SIB2-180). */
  composer?: string;
  /** An arranger credit under the composer (SIB2-180). Empty or null removes it. */
  arranger?: string | null;
  style?: string | null;
  key?: KeySignature;
  time?: TimeSignature;
  /** The page footer (SIB2-172): text, with `\n` for line breaks. Empty or null removes it. */
  footer?: string | null;
  /** Which pages carry it: `first`, `last` or `all` (the default). Needs a footer, new or existing. */
  footerPages?: 'first' | 'last' | 'all';
  /** Where the clef and key signature are drawn (SIB2-173): `every` system (the default), the `first`, or each `page`'s first. */
  signaturePolicy?: 'every' | 'first' | 'page';
  /** Bars to a line, 1 to 8 (SIB2-174). Null or 4 restores the four-bar grid. */
  barsPerSystem?: number | null;
  /** The chord symbology (SIB2-163): `standard`, `dash`, `words` or `real-book`. `standard` or null clears it. */
  chordStyle?: 'standard' | 'dash' | 'words' | 'real-book' | null;
  /** The tempo mark (SIB2-177): the beat and beats per minute. Null removes it. */
  tempo?: { unit: { value: number; dots?: number }; bpm: number } | null;
}

/**
 * A text direction above the staff (SIB2-169): a cue, a tempo, "unis.". Stored as an `Annotation` — the
 * model's free text at a beat, which import already creates — so it lives in the chord band and the
 * layout and engraver already draw it. An upsert at a place, like `chord.set`.
 */
export interface TextSetPayload {
  text: string;
  /** A bar address (`bar8`) the dashed continuation line runs to (SIB2-170). Null removes the line; absent keeps it. */
  until?: string | null;
  /** *Recorded.* The id the applier assigned (an existing direction at that beat keeps its own). */
  id?: Id;
}

export interface NoteAddPayload {
  /** A compact spec (`Eb5`) or the structure. Absent for a drum, whose place on the staff the drum map gives it. */
  pitch?: string | { step: string; alter: number; octave: number };
  /** A drum on a percussion staff (slice 6, `model/src/drums.ts`): `kick`, `snare`, `hihat`, `hihat-open`, `crash` and the rest. */
  drum?: string;
  /** A notehead other than the drum's own: `normal`, `x`, `diamond` or `circle-x`. */
  head?: string;
  duration: Duration;
  accidental?: AccidentalDisplay;
  tie?: TieRole;
  spellingPinned?: boolean;
  /** Staccato, accent and marcato marks (SIB2-179). */
  articulations?: Articulation[];
  /** *Recorded.* The id the applier assigned. */
  id?: Id;
}

export interface NoteSetPayload {
  pitch?: string | { step: string; alter: number; octave: number };
  /** Names the drum a note on a percussion staff strikes (and so where it is written); `null` makes it a plain note. */
  drum?: string | null;
  /** The notehead, `null` to return to the drum's own. */
  head?: string | null;
  duration?: Duration;
  accidental?: AccidentalDisplay;
  tie?: TieRole;
  spellingPinned?: boolean;
  /** Replaces the note's marks (SIB2-179); an empty list clears them. */
  articulations?: Articulation[];
}

export interface RestAddPayload {
  duration: Duration;
  /** *Recorded.* The id the applier assigned. */
  id?: Id;
}

/**
 * Set a chord symbol at a beat within a bar (Q32, ADR-0012). `set` is an upsert: it replaces the
 * chord already at that beat, or creates one if none is there — a chord *symbol* is a property of
 * a beat, not a stackable object like a note, so there is no separate `chord.add`.
 *
 * `text` is stored **verbatim**, always. Whether the grammar (`@sibei/music`) can parse it decides
 * only the review flag, never whether it is stored: unparseable text is kept and flagged, never
 * rejected (ADR-0012). The parsed structure is not stored — the text is the truth, and any reader
 * that needs the structure re-parses it, the same way the engraver and transposition will.
 */
export interface ChordSetPayload {
  /** The chord symbol as typed. `Cmaj7`, `F#m7b5`, `N.C.`, or something the grammar cannot read. */
  text: string;
  /** Pin the root's spelling so it survives transposition (ADR-0017). Defaults to unpinned. */
  spellingPinned?: boolean;
  /** *Recorded.* The id of the chord this set landed on — the existing one, or the one created. */
  id?: Id;
}

/**
 * Transpose the whole chart into a new concert key (ADR-0016). A **mutation**, not a view: the
 * score always stores concert pitch, so changing the concert key changes the tune, goes through the
 * log, and is undoable like any other edit (an instrument *part* is the other feature, and it stays
 * a render-time view — see `EXPORT_INSTRUMENTS`).
 *
 * The melody is respelled by the destination key signature, honouring per-note pins; chord roots
 * and slash basses move with it (ADR-0017). Nothing here is *recorded*: the respelling is a pure
 * function of the score's key at apply time and the target, both of which replay reproduces exactly,
 * so the target key is all the payload has to carry.
 */
export interface TransposePayload {
  /** The concert key to transpose into. */
  to: KeySignature;
}

/**
 * Upsert the section that begins on a bar (V7, R3, ADR-0021). The target is a whole-bar address
 * (`bar5`); the section is keyed by that start bar, so `set` replaces the section already starting
 * there — keeping its id — or creates one if none is. This mirrors `chord.set`'s upsert-at-a-place
 * shape rather than a stackable `add`, because a bar begins at most one section.
 *
 * A section is load-bearing for layout, not only notation: its start bar forces a line break in the
 * four-bar grid (ADR-0015), and its `letter`, when present, is engraved as a rehearsal mark. Both
 * `letter` and `name` are stored verbatim and may be omitted (left null) — a section can divide the
 * form without carrying a rehearsal letter. Sections are *supported and hand-added, never detected*
 * (ADR-0021), which is exactly what this op is.
 */
export interface SectionSetPayload {
  /** The rehearsal letter, e.g. `A`. Null clears it; omitted on an upsert keeps the existing one. */
  letter?: string | null;
  /** The section name, e.g. `Bridge`. Null clears it; omitted on an upsert keeps the existing one. */
  name?: string | null;
  /** *Recorded.* The id of the section this set landed on — the existing one, or the one created. */
  id?: Id;
}

/** Remove the section that begins on the target bar. A no-op target (no section there) is refused. */
export type SectionRmPayload = Record<string, never>;

/**
 * Set a bar's barlines (V7, ADR-0021). The target is a whole-bar address (`bar11`). A bar carries an
 * opening barline (`none` or a `repeat-start`) and a closing one (`single`, `double`, `final` or a
 * `repeat-end`); this sets either or both. At least one must be given — an empty set changes nothing.
 *
 * Barline *type* is hand-set, never detected (ADR-0021, D48): import yields single barlines, and a
 * double bar closing a section or a repeat around one is added here. A repeat pair is two of these,
 * which the CLI's `repeat set` batches into one undoable unit.
 */
export interface BarlineSetPayload {
  start?: StartBarline;
  end?: EndBarline;
}

/**
 * Set a bar's 1st/2nd-ending bracket (V7, ADR-0021). The target is a whole-bar address. `numbers`
 * are the pass numbers the bracket covers (`[1]`, `[2]`, `[1, 2]`); `role` says how the bracket runs
 * through this bar — `start` opens it with a down-hook and the number, `stop` closes it, `start-stop`
 * is a bracket that opens and closes on one bar, and `continue` is a middle bar under an unbroken
 * bracket. A multi-bar ending is one `start`, zero or more `continue`, and one `stop`, set per bar,
 * matching how the model carries the bracket (a field on each bar) and how the engraver draws it.
 */
export interface EndingSetPayload {
  numbers: number[];
  role: EndingRole;
}

/** Clear a bar's ending bracket. A no-op target (no ending there) is refused. */
export type EndingRmPayload = Record<string, never>;

/**
 * Bracket a run of items as a tuplet (SIB2-166). The target is the **first** item (`bar3.beat2` or its
 * id); the `count` items from there, in onset order, become members. `actual` notes are written in the
 * time of `normal` (a triplet is 3 in 2), so each member's duration is its written value scaled by
 * `normal/actual`. The members are written at their nominal values and this op re-lays them: they sit
 * back to back from the first member's onset at their scaled length, and every later item in the bar
 * moves with them, so a bar of three eighths in the time of two (`actual 3, normal 2`) closes up to one
 * beat. A ratio that would leave a member on a fractional tick, a run that overruns the bar's items, or
 * a member already inside a tuplet is refused (nesting is out of scope).
 */
export interface TupletSetPayload {
  /** Notes written, e.g. 3. At least 2, and different from `normal`. */
  actual: number;
  /** Notes' worth of time, e.g. 2. */
  normal: number;
  /** How many items the bracket spans, from the target. Defaults to `actual`. */
  count?: number;
  /** *Recorded.* The id of the tuplet the applier assigned. */
  id?: Id;
}

/** Remove the tuplet that holds the target item: the members go back to their written length, later items follow. */
export type TupletRmPayload = Record<string, never>;

/**
 * A slur from the target note to `to` (SIB2-167). The target is the note it starts on, `to` the note it ends
 * on, each any note address (`bar1.n2`, `note-7`); `to` must come later in reading order, in this bar or a
 * later one. Stored as a `Spanner` (ADR-0041), so it names the two notes by id and follows them.
 *
 * Setting the same pair again is an upsert: it keeps the slur's id and changes only `placement`. A slur
 * between two notes that is already there is not stacked twice. `placement` absent on a new slur means by
 * stem direction; `auto` on an existing one clears a choice.
 */
export interface SlurSetPayload {
  to: string;
  placement?: SpannerPlacement | 'auto';
  /** *Recorded.* The id of the slur this set landed on — the existing one, or the one created. */
  id?: Id;
}

/** Remove a slur, named by its id (`slur-2`, which `show` prints) or by the note it starts on. */
export type SlurRmPayload = Record<string, never>;

/**
/**
 * An ottava line (8va or 8vb) from the target note to `to` (SIB2-184), a `Spanner` of kind `ottava`. `shift` is
 * `up` (8va: written an octave below the sound, line above the staff) or `down` (8vb). The notes keep their
 * sounding pitch; they are only drawn shifted. Same pair again is an upsert that changes the shift.
 */
export interface OttavaSetPayload {
  to: string;
  shift: OctaveShift;
  /** *Recorded.* The id of the ottava this set landed on. */
  id?: Id;
}

/** Remove an ottava, named by its id (`ottava-1`, which `show` prints) or by the note it starts on. */
export type OttavaRmPayload = Record<string, never>;

/**
 * A fermata over the target note or rest (SIB2-183). Setting one that is already there changes nothing;
 * `fermata.rm` on an item with none is refused so a typo does not read as success.
 */
export type FermataSetPayload = Record<string, never>;
export type FermataRmPayload = Record<string, never>;

/**
 * A grace note before the target note (SIB2-185). The target is the principal note it belongs to (`bar2.n3`,
 * `note-7`); the new grace is appended after any it already has, so graces read in the order they were added. It
 * takes no time: it is not a bar item and never reaches the bar's metric validity (ADR-0013). `slashed` is an
 * acciaccatura, unslashed an appoggiatura; `value` (8, 16 or 32) sets its flags and beams.
 */
export interface GraceAddPayload {
  pitch: string | { step: string; alter: number; octave: number };
  value?: GraceValue;
  slashed?: boolean;
  accidental?: AccidentalDisplay;
  /** *Recorded.* The id the applier assigned. */
  id?: Id;
}

/**
 * Remove grace notes: the target is one grace's id (`grace-2`, which `show` prints) or a note's address, which
 * clears every grace on that note. A target with none is refused so a typo does not read as success.
 */
export type GraceRmPayload = Record<string, never>;

/** A line-break override on a bar (SIB2-174). `after` is the default: end the line after this bar. */
export interface BreakSetPayload {
  kind?: 'after' | 'join';
}
export type BreakRmPayload = Record<string, never>;

/**
 * Create a whole score from a document in one operation (V8c, ADR-0003). "An import is itself one
 * operation, carrying the whole parsed document" — the ADR's own words — and duplicate is exactly
 * that: an internal import of a copy. v0.2's OMR import will reuse this op rather than inventing a
 * second create-from-document path.
 *
 * **It is deliberately not a client-submittable verb.** It is missing from `OPERATION_TYPES`, and
 * the applier refuses it on the `/ops` route, because accepting a whole document from a client is
 * the document-patch anti-pattern ADR-0008 rejected — an LLM regenerating a document drops and
 * mangles fields, and one accept/reject tells it nothing. It reaches the log only through the
 * `duplicate` lifecycle call (V8c) and, later, the import pipeline (v0.2), both server-owned.
 */
/**
 * Add bars after a score is created (SIB2-186). The optional target is a whole-bar address; the new
 * bars go **after** it, so `bar8` makes bar 9 and every later bar and section start moves up by
 * `count`. With no target the bars are appended after the last bar. Bar numbers are the address
 * (ADR-0007), which is why inserting renumbers: a later bar's address changes, its id does not.
 */
export interface BarAddPayload {
  /** How many bars to add. Defaults to 1. */
  count?: number;
  /** *Recorded.* The ids the applier assigned, in order. */
  ids?: Id[];
}

/**
 * Structure (ADR-0041 section 2): parts, staves and voices. Every address below is the stable form a staff or part
 * has in text: `s2`/`staff-2` for the second staff, `s2.v2` for its second voice, `p2`/`part-2` for a part.
 *
 * Content ops (note, rest, tuplet, slur, ottava, grace, fermata) carry no `staff`/`voice` field: **the staff and voice
 * are part of the address**, `s2.v2.bar12.n3`, so an old payload (`bar12.n3`) is byte-for-byte what it always was and
 * means the first staff, first voice while the score has just one of each (it is an error listing the candidates once
 * it has more). One mechanism, so a target never disagrees with a field.
 */

/** Add a part with one staff (more with `staff.add`). Ids are *recorded*. */
export interface PartAddPayload {
  name?: string;
  /** A General MIDI program, 0-127, or null. */
  instrument?: number | null;
  /** Semitones from sounding to written pitch. */
  transposition?: number;
  /** The type of its first staff: `standard` (the default), `percussion` or `tab`. Only the tag, for now. */
  staffType?: StaffType;
  /** The first staff's opening clef. Defaults to treble (percussion for a percussion staff). */
  clef?: Clef;
  /** *Recorded.* */
  id?: Id;
  /** *Recorded.* The first staff's id. */
  staffId?: Id;
}

/** A part holding notation is refused unless `force` is true, the way `bar rm` refuses a bar with content. */
export interface PartRmPayload {
  force?: boolean;
}

/** Add a staff to the target part (the last part if there is no target). */
export interface StaffAddPayload {
  type?: StaffType;
  clef?: Clef;
  /** *Recorded.* */
  id?: Id;
}

export interface StaffRmPayload {
  force?: boolean;
}

/** Add a voice to the target staff (the only staff, if there is just one) as its lowest free index from 2 to 4. */
export interface VoiceAddPayload {
  /** *Recorded.* The index the applier chose. */
  index?: number;
}

export interface VoiceRmPayload {
  force?: boolean;
}

/** `s2` sets the staff's opening clef; `s2.bar5` a change from bar 5, where `null` clears the change. */
export interface ClefSetPayload {
  clef: Clef | null;
}

export interface InstrumentSetPayload {
  name?: string;
  instrument?: number | null;
  transposition?: number;
}

export interface ScoreImportPayload {
  document: Score;
}

/**
 * The verbs implemented so far. V2 built the note and rest verbs; V5 added `chord.set` and
 * `chord.rm`; V6 added `transpose`; V7 adds `section.set`/`section.rm` and the barline and ending
 * verbs — `barline.set`, `ending.set` and `ending.rm`. `tie` and `tuplet` each belong to a later
 * slice and building them here would be doing that slice's work early.
 *
 * **`Operation` is the *content* vocabulary: every member mutates the document, and every member is
 * folded by `applyOperation` as a pure `(score, op) -> score`.** Undo and redo are deliberately not
 * in this union — they are `ControlOperation`s (below), because they cannot be folded from the score
 * alone: their result depends on the whole log, which the pure applier never sees.
 *
 * `score.import` is in the union — it folds like any create — but not in `OPERATION_TYPES`, because
 * it is server-only (see its payload): the client verb set is `OPERATION_TYPES`, and `score.import`
 * is reached through the `duplicate` lifecycle call, not the `/ops` route.
 */
export type Operation =
  | { type: 'score.create'; payload: ScoreCreatePayload }
  | { type: 'score.import'; payload: ScoreImportPayload }
  | { type: 'meta.set'; payload: MetaSetPayload }
  | { type: 'note.add'; target: string; payload: NoteAddPayload }
  | { type: 'note.set'; target: string; payload: NoteSetPayload }
  | { type: 'note.rm'; target: string }
  | { type: 'rest.add'; target: string; payload: RestAddPayload }
  | { type: 'rest.rm'; target: string }
  | { type: 'chord.set'; target: string; payload: ChordSetPayload }
  | { type: 'chord.rm'; target: string }
  | { type: 'text.set'; target: string; payload: TextSetPayload }
  | { type: 'text.rm'; target: string }
  | { type: 'transpose'; payload: TransposePayload }
  | { type: 'section.set'; target: string; payload: SectionSetPayload }
  | { type: 'section.rm'; target: string; payload?: SectionRmPayload }
  | { type: 'barline.set'; target: string; payload: BarlineSetPayload }
  | { type: 'ending.set'; target: string; payload: EndingSetPayload }
  | { type: 'ending.rm'; target: string; payload?: EndingRmPayload }
  | { type: 'tuplet.set'; target: string; payload: TupletSetPayload }
  | { type: 'tuplet.rm'; target: string; payload?: TupletRmPayload }
  | { type: 'break.set'; target: string; payload?: BreakSetPayload }
  | { type: 'break.rm'; target: string; payload?: BreakRmPayload }
  | { type: 'fermata.set'; target: string; payload?: FermataSetPayload }
  | { type: 'fermata.rm'; target: string; payload?: FermataRmPayload }
  | { type: 'slur.set'; target: string; payload: SlurSetPayload }
  | { type: 'slur.rm'; target: string; payload?: SlurRmPayload }
  | { type: 'ottava.set'; target: string; payload: OttavaSetPayload }
  | { type: 'ottava.rm'; target: string; payload?: OttavaRmPayload }
  | { type: 'grace.add'; target: string; payload: GraceAddPayload }
  | { type: 'grace.rm'; target: string; payload?: GraceRmPayload }
  | { type: 'bar.add'; target?: string; payload?: BarAddPayload }
  | { type: 'bar.rm'; target: string }
  | { type: 'part.add'; payload?: PartAddPayload }
  | { type: 'part.rm'; target: string; payload?: PartRmPayload }
  | { type: 'staff.add'; target?: string; payload?: StaffAddPayload }
  | { type: 'staff.rm'; target: string; payload?: StaffRmPayload }
  | { type: 'voice.add'; target?: string; payload?: VoiceAddPayload }
  | { type: 'voice.rm'; target: string; payload?: VoiceRmPayload }
  | { type: 'clef.set'; target: string; payload: ClefSetPayload }
  | { type: 'instrument.set'; target?: string; payload: InstrumentSetPayload };

export type OperationType = Operation['type'];

export const OPERATION_TYPES: readonly OperationType[] = [
  'score.create',
  'meta.set',
  'note.add',
  'note.set',
  'note.rm',
  'rest.add',
  'rest.rm',
  'chord.set',
  'chord.rm',
  'text.set',
  'text.rm',
  'transpose',
  'section.set',
  'section.rm',
  'barline.set',
  'ending.set',
  'ending.rm',
  'tuplet.set',
  'tuplet.rm',
  'break.set',
  'break.rm',
  'fermata.set',
  'fermata.rm',
  'slur.set',
  'slur.rm',
  'ottava.set',
  'ottava.rm',
  'grace.add',
  'grace.rm',
  'bar.add',
  'bar.rm',
  'part.add',
  'part.rm',
  'staff.add',
  'staff.rm',
  'voice.add',
  'voice.rm',
  'clef.set',
  'instrument.set',
];

/**
 * Undo and redo as they sit in the log (V8a, ADR-0003).
 *
 * **They are operations in the log, but not `Operation`s.** ADR-0003 keeps the log append-only
 * forever — nothing ever UPDATEs or DELETEs a row, because rewriting history is exactly what
 * undo-by-replay must never be able to do — so undo cannot delete the last batch's rows. Instead it
 * appends a *control* operation: a marker that says "the last applied batch is now undone". Replay
 * resolves these markers against the log (see `resolveLog` in `apply.ts`), so the append-only log
 * still reproduces the stored document exactly, which is the property the whole write path rests on.
 *
 * This is not an inverse operation (ADR-0003 rejected those): there is one control op, not a
 * provably-correct inverse per verb, and undo's *result* is still `replay(the log minus the last
 * batch)` — the control op is only how that decision is persisted. It needs no schema change: the
 * existing `type`/`payload`/`batch` columns already carry it, and a control op is its own batch of
 * one, so it is itself a unit the way an edit is (undo of undo is `redo`, not a second marker on the
 * same batch).
 */
export type ControlOperation = { type: 'undo' } | { type: 'redo' };

export type ControlOperationType = ControlOperation['type'];

export const CONTROL_OPERATION_TYPES: readonly ControlOperationType[] = ['undo', 'redo'];

/**
 * Anything that can sit in the log: a content `Operation` or a `ControlOperation`. The store reads
 * and writes this; `applyOperation` only ever sees the content half, because `resolveLog` strips the
 * control ops away before folding.
 */
export type LoggedOperation = Operation | ControlOperation;

export function isControlOperation(operation: LoggedOperation): operation is ControlOperation {
  return operation.type === 'undo' || operation.type === 'redo';
}

/** An operation as it sits in the log: normalised, sequenced, and grouped into its batch. */
export interface StoredOperation {
  /** 1-based, per score, gapless. The order replay walks. */
  seq: number;
  /**
   * The undoable unit this operation belongs to (ADR-0003). A `batch` is one unit whatever its
   * length; a lone operation is a unit of one. Undo (V8a) drops the last group, not the last row
   * — the column is here from the first commit because adding it after a library exists is the
   * expensive version of the same decision.
   */
  batch: number;
  /** The operation shape's own version, not the document's (ADR-0028). */
  version: number;
  /** A content edit or an undo/redo control marker (V8a). */
  operation: LoggedOperation;
  /** ISO-8601. Audit only: nothing in the document depends on it, so replay ignores it. */
  createdAt: string;
}

/** A list applied in one transaction: all of it, or none of it (ADR-0008). */
export interface Batch {
  operations: readonly Operation[];
  /**
   * The version the client believes the score is at (ADR-0003).
   *
   * **Required for every batch that is not a create, and a batch without one is refused** — see
   * `isCreateBatch`. This used to say only "absent for a create", which was the intent and was
   * enforced by nothing: an edit that omitted it applied against whatever the score happened to be
   * at, overwriting the last writer with no conflict and no signal (KAN-607). Optional in the type
   * because the exemption is real and cannot be expressed in one: whether a batch is a create is
   * decided by `operations[0].type`, which is data rather than something a type can discriminate on
   * across the wire.
   */
  expectedVersion?: number;
}

/**
 * Whether this batch creates the score it is about, and is therefore the one kind of batch with no
 * version to expect.
 *
 * **One expression, used twice**: it picks the applier's create-versus-mutate path *and* it decides
 * the `expectedVersion` exemption. Two conditions saying the same thing in two places is how a
 * later edit to one of them turns the exemption into a hole — this rule has to be that the exempt
 * batch is exactly the batch that has nothing to be stale against.
 *
 * Only the *first* operation decides. A create further down a batch is not an exemption, and it is
 * refused on its own account (`conflict-exists`, or `bad-first-operation` for the reverse case).
 *
 * A create that carries an `expectedVersion` anyway is **ignored rather than refused**, which is the
 * one place this file tolerates a field going unused. It was weighed against this repo's habit of
 * refusing anything it cannot honour (an unsupported `paper` is a 422, an address never snaps) and
 * the cases are not alike: those change what the caller gets back, whereas a create is already
 * guarded — by an id that is either taken or not — so the field is redundant rather than misleading.
 * Refusing it would also make `POST /v1/scores` fail for a client that sent one field too many,
 * which is a poor trade for a redundancy.
 */
export function isCreateBatch(batch: Batch): boolean {
  return batch.operations[0]?.type === 'score.create';
}
