import type {
  AccidentalDisplay,
  Duration,
  Id,
  KeySignature,
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
  composer?: string;
  style?: string | null;
  key?: KeySignature;
  time?: TimeSignature;
}

export interface NoteAddPayload {
  /** A compact spec (`Eb5`) or the structure. */
  pitch: string | { step: string; alter: number; octave: number };
  duration: Duration;
  accidental?: AccidentalDisplay;
  tie?: TieRole;
  spellingPinned?: boolean;
  /** *Recorded.* The id the applier assigned. */
  id?: Id;
}

export interface NoteSetPayload {
  pitch?: string | { step: string; alter: number; octave: number };
  duration?: Duration;
  accidental?: AccidentalDisplay;
  tie?: TieRole;
  spellingPinned?: boolean;
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
  /** *Recorded.* The id of the chord this set landed on — the existing one, or the one created. */
  id?: Id;
}

/**
 * The verbs implemented so far. V2 built the note and rest verbs; V5 adds `chord.set` and
 * `chord.rm` (this slice). `section`, `repeat`, `tie`, `tuplet`, `transpose` and `undo` each
 * belong to a later slice and building them here would be doing that slice's work early.
 */
export type Operation =
  | { type: 'score.create'; payload: ScoreCreatePayload }
  | { type: 'meta.set'; payload: MetaSetPayload }
  | { type: 'note.add'; target: string; payload: NoteAddPayload }
  | { type: 'note.set'; target: string; payload: NoteSetPayload }
  | { type: 'note.rm'; target: string }
  | { type: 'rest.add'; target: string; payload: RestAddPayload }
  | { type: 'rest.rm'; target: string }
  | { type: 'chord.set'; target: string; payload: ChordSetPayload }
  | { type: 'chord.rm'; target: string };

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
];

/** An operation as it sits in the log: normalised, sequenced, and grouped into its batch. */
export interface StoredOperation {
  /** 1-based, per score, gapless. The order replay walks. */
  seq: number;
  /**
   * The undoable unit this operation belongs to (ADR-0003). A `batch` is one unit whatever its
   * length; a lone operation is a unit of one. Undo (V8) drops the last group, not the last row
   * — the column is here from the first commit because adding it after a library exists is the
   * expensive version of the same decision.
   */
  batch: number;
  /** The operation shape's own version, not the document's (ADR-0028). */
  version: number;
  operation: Operation;
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
