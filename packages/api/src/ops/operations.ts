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
 * The verbs this slice implements, and deliberately only these: what V2's demo and test plan
 * need. `chord`, `section`, `repeat`, `tie`, `tuplet`, `transpose` and `undo` each belong to a
 * later slice and building them here would be doing that slice's work early.
 */
export type Operation =
  | { type: 'score.create'; payload: ScoreCreatePayload }
  | { type: 'meta.set'; payload: MetaSetPayload }
  | { type: 'note.add'; target: string; payload: NoteAddPayload }
  | { type: 'note.set'; target: string; payload: NoteSetPayload }
  | { type: 'note.rm'; target: string }
  | { type: 'rest.add'; target: string; payload: RestAddPayload }
  | { type: 'rest.rm'; target: string };

export type OperationType = Operation['type'];

export const OPERATION_TYPES: readonly OperationType[] = [
  'score.create',
  'meta.set',
  'note.add',
  'note.set',
  'note.rm',
  'rest.add',
  'rest.rm',
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
  /** The version the client believes the score is at. Absent for a create. */
  expectedVersion?: number;
}
