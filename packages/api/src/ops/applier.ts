import type { Id, Score } from '@sibei/model';
import { applyOperation } from './apply.js';
import { OperationError } from './errors.js';
import { OPERATION_VERSION } from './operations.js';
import type { Batch, Operation, StoredOperation } from './operations.js';
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

      const creating = batch.operations[0]?.type === 'score.create';
      return creating
        ? create(store, owner, batch, now)
        : mutate(store, owner, requireId(scoreId), batch, now);
    },
  };
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
  now: () => Date,
): ApplyResult {
  const current = store.get(owner, scoreId);
  if (current === null) throw new OperationError({ kind: 'no-such-score', id: scoreId });

  // The version is checked here for a clear early error *and* again inside the commit statement,
  // which is the one that actually decides. Only the second is atomic; this one exists so the
  // common case reports the conflict without a wasted apply.
  const expected = batch.expectedVersion ?? current.version;
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
function stamp(operations: readonly Operation[], now: () => Date): StoredOperation[] {
  const createdAt = `${now().toISOString().slice(0, 19)}Z`;
  return operations.map((operation) => ({
    seq: 0,
    batch: 0,
    version: OPERATION_VERSION,
    operation,
    createdAt,
  }));
}
