import type { Id, Score } from '@sibei/model';
import { applyOperation, replay, resolveLog } from './apply.js';
import { OperationError } from './errors.js';
import { OPERATION_VERSION, isCreateBatch } from './operations.js';
import type { Batch, ControlOperation, LoggedOperation, Operation, StoredOperation } from './operations.js';
import type { Owner, ScoreReader, ScoreWriter } from '../store/repository.js';

/**
 * The op applier: **the only thing that writes to the store** (ADR-0003).
 *
 * The pure reducer lives in `apply.ts`. This is the thin shell around it that reads the current
 * document, folds the batch over it, and commits — and it is deliberately thin, because
 * everything interesting should be testable without a database.
 *
 * "The UI and the CLI can never disagree" is structurally true rather than maintained by
 * discipline, and it rests on three things this file is half of: there is no second write path,
 * because both surfaces are HTTP clients of one API (ADR-0002); the only writes to the store come
 * from here; and replaying a log from empty reproduces the stored document exactly.
 */

export interface Applier {
  apply(owner: Owner, scoreId: Id | null, batch: Batch): ApplyResult;
  /**
   * Undo the last applied batch, and redo the last undone one, by replay of the op log (V8a,
   * ADR-0003). Both carry an `expectedVersion` for the same optimistic-concurrency reason a write
   * does: a client undoing what it holds must not silently revert an edit that landed since. Both
   * go through the one write path — they are the only thing besides `apply` that appends to the log,
   * and they do it here rather than in a route because computing the result needs to *read* the log,
   * which the pure applier in `apply.ts` never can.
   */
  undo(owner: Owner, scoreId: Id, expectedVersion: number | undefined): UndoResult;
  redo(owner: Owner, scoreId: Id, expectedVersion: number | undefined): UndoResult;
  /**
   * Copy a score to a new one with a fresh, single-operation log (V8c). A library-lifecycle call
   * like delete — but where delete cannot be an op (it destroys a log), duplicate *creates* one, so
   * it goes through the applier, the only writer (ADR-0003). The copy's log is one `score.import`
   * carrying the snapshot, so it replays to the copy exactly and has nothing to undo — the "fresh
   * history" a duplicate is expected to have. `newId` is minted from the source id when omitted.
   */
  duplicate(owner: Owner, scoreId: Id, newId: Id | undefined): DuplicateResult;
  /**
   * Land a whole document as a new score in one operation (V11, R5). The server-only counterpart of
   * `duplicate`: where duplicate copies an existing score's current document, this takes a document
   * the OMR importer produced (`mapOmrToScore`) and creates a score from it. It folds one
   * `score.import` op carrying the document, so the import is a single undoable unit — undoing it
   * leaves an empty score and the log still replays exactly (ADR-0003, ADR-0008) — exactly the
   * property the V11 test plan names ("undoing an import leaves an empty score").
   *
   * Like duplicate, it reaches `score.import` only here, never the `/ops` route: accepting a whole
   * document from a client is the document-patch anti-pattern ADR-0008 rejected. The runner (the OMR
   * job runner, the only caller) holds a `JobWriter`, never a `ScoreWriter`, so this narrow applier
   * capability is the one path by which a recognised chart becomes a score without a second writer.
   * The document already carries the id the caller minted for it.
   */
  import(owner: Owner, document: Score): ImportResult;
}

export interface ApplyResult {
  scoreId: Id;
  /** The version after the write. A client's next `expectedVersion`. */
  version: number;
  /** Ids of everything the batch touched (PLAN.md's op contract). */
  changed: Id[];
  /** The operations as logged: normalised, sequenced by the store. */
  applied: readonly Operation[];
}

/**
 * The outcome of an undo or a redo (V8a).
 *
 * `moved` is the honest answer to "was there anything to do": false at the undo floor (a score with
 * only its `score.create` batch — undoing that would leave no score, which ADR-0003 does not do) and
 * past the redo head (nothing was undone to bring back). A no-op does not bump the version and
 * appends nothing to the log — it is a clean answer, not an error, which is what the unit test at
 * the first operation and past the head demands. `canUndo`/`canRedo` let a surface light or dim its
 * controls without a second round trip.
 */
export interface UndoResult {
  scoreId: Id;
  /** The version after the move, or the unchanged version on a no-op. */
  version: number;
  /** `[scoreId]` when the document moved, empty on a no-op — the whole document is what changed. */
  changed: Id[];
  moved: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

/** The outcome of a duplicate (V8c): the new score's id and its starting version (always 1). */
export interface DuplicateResult {
  scoreId: Id;
  version: number;
  /** The chart this was copied from, echoed so a caller need not remember what it asked. */
  sourceId: Id;
}

/** The outcome of an import (V11): the created score's id and its starting version (always 1). */
export interface ImportResult {
  scoreId: Id;
  version: number;
}

/**
 * Construct the applier with the two halves of the store port. Taking a `ScoreWriter`
 * *explicitly* is what makes "only the applier writes" a wiring fact rather than a convention: a
 * route handler is built with a reader and cannot reach a write path even by mistake.
 */
export function createApplier(
  store: ScoreReader & ScoreWriter,
  now: () => Date = () => new Date(),
): Applier {
  return {
    apply(owner, scoreId, batch) {
      if (batch.operations.length === 0) {
        throw new OperationError({
          kind: 'validation',
          detail: 'a batch needs at least one operation',
        });
      }

      // `score.import` is server-only (`operations.ts`): accepting a whole document from a client is
      // the document-patch anti-pattern ADR-0008 rejected. It reaches the log only via `duplicate`.
      for (const operation of batch.operations) {
        if (operation.type === 'score.import') {
          throw new OperationError({ kind: 'unknown-operation', type: 'score.import' });
        }
      }

      if (isCreateBatch(batch)) return create(store, owner, batch, now);

      // Both questions are about the batch itself, so both are asked before the store is touched:
      // the answer to "is this a write I can even attempt" must not depend on which ids happen to
      // exist. It also means neither refusal can report on a score's existence.
      const id = requireId(scoreId);
      const expected = requireExpectedVersion(batch);
      return mutate(store, owner, id, batch, expected, now);
    },

    undo(owner, scoreId, expectedVersion) {
      return move(store, owner, scoreId, expectedVersion, 'undo', now);
    },

    redo(owner, scoreId, expectedVersion) {
      return move(store, owner, scoreId, expectedVersion, 'redo', now);
    },

    duplicate(owner, scoreId, newId) {
      return duplicate(store, owner, scoreId, newId, now);
    },

    import(owner, document) {
      return importDocument(store, owner, document, now);
    },
  };
}

/**
 * Create a new score from a whole document in one `score.import` op (V11). The same one-transaction
 * `store.create` path duplicate and `score.create` take, so the import is atomic and its single-op
 * log replays to exactly this document. The document arrives with its id already set (the runner
 * mints it from the job); a clash with an existing id is a conflict, not a silent overwrite.
 */
function importDocument(
  store: ScoreReader & ScoreWriter,
  owner: Owner,
  document: Score,
  now: () => Date,
): ImportResult {
  const applied = applyOperation(null, { type: 'score.import', payload: { document } });

  const outcome = store.create(owner, applied.score, stamp([applied.operation], now));
  if (!outcome.ok) {
    if (outcome.reason === 'already-exists') throw new OperationError({ kind: 'conflict-exists', id: document.id });
    throw new OperationError({ kind: 'validation', detail: `the store refused: ${outcome.reason}` });
  }
  return { scoreId: document.id, version: outcome.version };
}

/**
 * Copy a score to a new one with a single-operation log (V8c). The copy's document is the source's
 * current document under a new id; its log is one `score.import` carrying that document, so
 * replay-from-empty reproduces the copy and there is nothing to undo. The write is one transaction
 * through the store's `create`, the same path `score.create` takes.
 */
function duplicate(
  store: ScoreReader & ScoreWriter,
  owner: Owner,
  sourceId: Id,
  newId: Id | undefined,
  now: () => Date,
): DuplicateResult {
  const source = store.get(owner, sourceId);
  if (source === null) throw new OperationError({ kind: 'no-such-score', id: sourceId });

  const id = newId ?? freeCopyId(store, owner, sourceId);
  const document = { ...source.score, id };
  const applied = applyOperation(null, { type: 'score.import', payload: { document } });

  const outcome = store.create(owner, applied.score, stamp([applied.operation], now));
  if (!outcome.ok) {
    if (outcome.reason === 'already-exists') throw new OperationError({ kind: 'conflict-exists', id });
    throw new OperationError({ kind: 'validation', detail: `the store refused: ${outcome.reason}` });
  }
  return { scoreId: id, version: outcome.version, sourceId };
}

/** The first free `<id>-copy`, `<id>-copy-2`, … — readable, and it does not collide on a re-run. */
function freeCopyId(store: ScoreReader, owner: Owner, sourceId: Id): Id {
  const base = `${sourceId}-copy`;
  if (!store.exists(owner, base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!store.exists(owner, candidate)) return candidate;
  }
}

/**
 * Undo and redo, as one function because they are one shape (V8a).
 *
 * Read the log, resolve its undo/redo markers to the batches in effect (`resolveLog`), and either
 * drop the last applied batch or bring back the last undone one. The new document is `replay(the
 * effective content ops)` — undo really is "replay the log minus the last batch", exactly as
 * ADR-0003 says, and redo re-applies the batch it set aside. What lands in the log is a single
 * control marker; the append-only log then reproduces this very document on the next replay.
 *
 * The version is checked first, so a stale undo is a conflict a client re-reads from rather than a
 * revert applied on top of an edit it never saw (ADR-0003). The floor is the `score.create` batch:
 * undo stops there rather than leaving no score at all.
 */
function move(
  store: ScoreReader & ScoreWriter,
  owner: Owner,
  scoreId: Id,
  expectedVersion: number | undefined,
  direction: 'undo' | 'redo',
  now: () => Date,
): UndoResult {
  if (expectedVersion === undefined) throw new OperationError({ kind: 'missing-expected-version' });

  const current = store.get(owner, scoreId);
  if (current === null) throw new OperationError({ kind: 'no-such-score', id: scoreId });
  if (expectedVersion !== current.version) {
    throw new OperationError({ kind: 'stale-version', expected: expectedVersion, current: current.version });
  }

  const { applied, redo } = resolveLog(store.operations(owner, scoreId));

  // The batches that would be in effect *after* this move. Undo drops the last applied batch (but
  // never the create at the floor); redo brings back the last undone one.
  const canUndo = applied.length > 1;
  const canRedo = redo.length > 0;
  const nextApplied =
    direction === 'undo'
      ? canUndo
        ? applied.slice(0, -1)
        : null
      : canRedo
        ? [...applied, redo[redo.length - 1]!]
        : null;

  if (nextApplied === null) {
    // Nothing to do: the undo floor or the redo head. A clean no-op — no version bump, no log row.
    return { scoreId, version: current.version, changed: [], moved: false, canUndo, canRedo };
  }

  const next = replay(nextApplied.flat());
  if (next === null) {
    // Unreachable: `nextApplied` always keeps the `score.create` batch, so it never folds to null.
    throw new OperationError({ kind: 'validation', detail: `${direction} produced no score` });
  }

  const marker: ControlOperation = { type: direction };
  const outcome = store.commit(owner, scoreId, expectedVersion, next, stamp([marker], now));
  if (!outcome.ok) {
    if (outcome.reason === 'conflict') {
      throw new OperationError({ kind: 'stale-version', expected: expectedVersion, current: outcome.version });
    }
    if (outcome.reason === 'not-found') throw new OperationError({ kind: 'no-such-score', id: scoreId });
    throw new OperationError({ kind: 'conflict-exists', id: scoreId });
  }

  // Availability *after* the move, so a surface can dim its controls from the same result.
  const nowCanUndo = nextApplied.length > 1;
  const nowCanRedo = direction === 'undo' ? true : redo.length > 1;
  return { scoreId, version: outcome.version, changed: [scoreId], moved: true, canUndo: nowCanUndo, canRedo: nowCanRedo };
}

function requireId(scoreId: Id | null): Id {
  if (scoreId === null || scoreId === '') {
    throw new OperationError({
      kind: 'bad-target',
      type: 'batch',
      detail: 'needs a score to act on; only score.create may start without one',
    });
  }
  return scoreId;
}

/**
 * ADR-0003's third mechanism, **wired rather than intended** (KAN-607).
 *
 * The ADR is unambiguous — "every write carries the version the client expects" — and until now
 * nothing enforced it: an edit that named no version was applied against whatever the score was at,
 * which is last-write-wins, the policy the ADR explicitly rejects because it "silently destroys the
 * other party's edit — much worse when the other party is an agent working unattended". The other
 * two mechanisms are facts of the wiring (there is no second write path; only this file writes), and
 * this one was a convention both clients happened to follow. That made it true by luck up to the
 * slice where a human first clicks a button that writes.
 *
 * It is refused here rather than at the HTTP boundary because *this* is the single write path. A
 * check in `routes.ts` would protect one caller and leave the next one — an importer, a second
 * surface, a script — to remember. Nothing narrower than the writer holds for everything that
 * writes.
 *
 * Breaking a shipped request shape is permitted inside v1 until the hosted transition (ADR-0022),
 * and this is the cheap moment to do it: one client (the CLI) and one read-only client (the
 * browser).
 */
function requireExpectedVersion(batch: Batch): number {
  if (batch.expectedVersion === undefined) {
    throw new OperationError({ kind: 'missing-expected-version' });
  }
  return batch.expectedVersion;
}

function create(
  store: ScoreReader & ScoreWriter,
  owner: Owner,
  batch: Batch,
  now: () => Date,
): ApplyResult {
  const { score, applied, changed } = fold(null, batch.operations);
  if (score === null) {
    // Unreachable: a batch starting with score.create always produces a score.
    throw new OperationError({ kind: 'validation', detail: 'score.create produced no score' });
  }

  const outcome = store.create(owner, score, stamp(applied, now));
  if (!outcome.ok) {
    if (outcome.reason === 'already-exists') {
      throw new OperationError({ kind: 'conflict-exists', id: score.id });
    }
    throw new OperationError({ kind: 'validation', detail: `the store refused: ${outcome.reason}` });
  }
  return { scoreId: score.id, version: outcome.version, changed, applied };
}

function mutate(
  store: ScoreReader & ScoreWriter,
  owner: Owner,
  scoreId: Id,
  batch: Batch,
  /** Never optional, which is the fix: there is no longer a fallback to fall through to. */
  expected: number,
  now: () => Date,
): ApplyResult {
  const current = store.get(owner, scoreId);
  if (current === null) throw new OperationError({ kind: 'no-such-score', id: scoreId });

  // The version is checked here for a clear early error *and* again inside the commit statement,
  // which is the one that actually decides. Only the second is atomic; this one exists so the
  // common case reports the conflict without a wasted apply.
  if (expected !== current.version) {
    throw new OperationError({
      kind: 'stale-version',
      expected,
      current: current.version,
    });
  }

  // The whole batch folds before anything is written, so an operation that throws takes the
  // entire batch with it and none of it lands (ADR-0008). Atomicity comes from this and from the
  // single transaction the store commits in, not from either alone.
  const { score, applied, changed } = fold(current.score, batch.operations);
  if (score === null) {
    throw new OperationError({ kind: 'validation', detail: 'the batch produced no score' });
  }

  const outcome = store.commit(owner, scoreId, current.version, score, stamp(applied, now));
  if (!outcome.ok) {
    if (outcome.reason === 'conflict') {
      // Somebody wrote between the read and the commit. The statement refused, nothing landed.
      throw new OperationError({
        kind: 'stale-version',
        expected: current.version,
        current: outcome.version,
      });
    }
    if (outcome.reason === 'not-found') {
      throw new OperationError({ kind: 'no-such-score', id: scoreId });
    }
    throw new OperationError({ kind: 'conflict-exists', id: scoreId });
  }
  return { scoreId, version: outcome.version, changed, applied };
}

/** Fold a batch over a document. Pure — this is exactly what replay does. */
function fold(
  from: Score | null,
  operations: readonly Operation[],
): { score: Score | null; applied: Operation[]; changed: Id[] } {
  let score = from;
  const applied: Operation[] = [];
  const changed: Id[] = [];

  for (const [index, operation] of operations.entries()) {
    const result = applyOperation(score, operation, operations.length > 1 ? index : undefined);
    score = result.score;
    applied.push(result.operation);
    for (const id of result.changed) if (!changed.includes(id)) changed.push(id);
  }
  return { score, applied, changed };
}

/**
 * Wrap the normalised operations for the log. `seq` and `batch` are left to the store, which owns
 * the log's ordering; a caller choosing its own sequence numbers is a race waiting to be written.
 */
function stamp(operations: readonly LoggedOperation[], now: () => Date): StoredOperation[] {
  const createdAt = `${now().toISOString().slice(0, 19)}Z`;
  return operations.map((operation) => ({
    seq: 0,
    batch: 0,
    version: OPERATION_VERSION,
    operation,
    createdAt,
  }));
}
