import type { Id, Score } from '@sibei/model';
import type { StoredOperation } from '../ops/operations.js';

/**
 * The store port (ADR-0006). Nothing above this file may know that SQLite exists — that is
 * asserted by `tests/arch`, not left to discipline, because "swappable" is the entire reason
 * the interface is here. The hosted future replaces the implementation and nothing else
 * (R8, ADR-0001).
 */

/**
 * The principal a row belongs to. Always `'local'` in the MVP — the auth seam resolves every
 * request to it (ADR-0029) — and every query filters on it *anyway*, so that adding real
 * principals later is a change to the seam rather than to every statement.
 */
export type Owner = string;

export const LOCAL_OWNER: Owner = 'local';

/** A score as stored: the document, plus the row state around it. */
export interface ScoreRecord {
  score: Score;
  /**
   * The optimistic-concurrency version (ADR-0003). Bumped by the op applier and by nothing
   * else — notably *not* by a migration write-back, which is not an edit (ADR-0028).
   */
  version: number;
  /** ISO-8601, UTC. */
  updatedAt: string;
}

/**
 * One row of the library view, built from the columns ADR-0006 extracts alongside the
 * document. Deliberately not a `Score`: listing a library must not deserialise every chart.
 */
export interface ScoreListing {
  id: Id;
  title: string;
  composer: string;
  /** The key in compact form, e.g. `Db` or `Fm`. See `formatKeySignature`. */
  key: string;
  version: number;
  updatedAt: string;
}

/**
 * Reads. Anything may hold one of these.
 */
export interface ScoreReader {
  list(owner: Owner): ScoreListing[];
  /**
   * The document at the current schema version, migrating on read if it is behind
   * (ADR-0028). Throws `DocumentMigrationError` for a document this build cannot read;
   * returns null when there is no such score for this owner.
   */
  get(owner: Owner, id: Id): ScoreRecord | null;
  exists(owner: Owner, id: Id): boolean;
  /**
   * The score's whole operation log in sequence order (ADR-0003). Reading is safe for anyone —
   * it is the audit trail, the input to replay, and what undo walks backwards.
   */
  operations(owner: Owner, id: Id): StoredOperation[];
}

/** The outcome of a write that carried an expected version (ADR-0003). */
export type WriteOutcome =
  | { ok: true; version: number; updatedAt: string }
  /** A stale write. The current version comes back so the client can re-read and retry. */
  | { ok: false; reason: 'conflict'; version: number }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'already-exists' };

/**
 * Writes to a score's document.
 *
 * A separate interface rather than more methods on the reader, because **the op applier is
 * the only thing that may hold one** (ADR-0003). Keeping the capability in its own type is
 * what lets that be wired rather than merely intended: a route handler is constructed with a
 * `ScoreReader` and cannot reach a write path even by accident.
 *
 * The applier itself arrives in V2c. This slice defines the seam it plugs into and proves
 * the store honours it.
 */
export interface ScoreWriter {
  /**
   * Create a score and append the operations that created it, in **one transaction**.
   * `version` starts at 1.
   *
   * Creation is itself an operation (`score.create`), which is what keeps replay-from-empty
   * true as a property rather than an aspiration (ADR-0003) — so it comes through here like
   * every other write, not beside it.
   */
  create(owner: Owner, score: Score, operations: readonly StoredOperation[]): WriteOutcome;
  /**
   * Replace the document and append its operations if and only if the stored version is
   * `expectedVersion`, bumping it on success. One transaction, and the version check is part of
   * the same statement as the write, so two concurrent writers cannot both win — no locks and no
   * last-write-wins (ADR-0003).
   *
   * A batch of operations arrives here as one call and commits as one unit: one invalid
   * operation earlier in the applier means this is never reached, so none of them land
   * (ADR-0008).
   */
  commit(
    owner: Owner,
    id: Id,
    expectedVersion: number,
    score: Score,
    operations: readonly StoredOperation[],
  ): WriteOutcome;
}

/**
 * Removing a chart from the library.
 *
 * Separate from `ScoreWriter` on purpose. Creating a score is an op inside the log; deleting
 * one cannot be, because it destroys the log the entry would live in. So this is a library
 * lifecycle operation, not a mutation of a score, and it does not go through the applier.
 * ADR-0003's "every mutation is an operation" is about mutations *of a score*.
 */
export interface ScoreLibrary {
  delete(owner: Owner, id: Id): boolean;
}

/** The whole store. Composed, then handed out as the narrower halves it is made of. */
export interface ScoreStore extends ScoreReader, ScoreWriter, ScoreLibrary {
  /** Release the underlying resources. Tests and process shutdown; nothing else. */
  close(): void;
}
