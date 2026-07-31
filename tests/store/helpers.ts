import { OPERATION_VERSION } from '@sibei/api';
import type { Operation, ScoreStore, StoredOperation, WriteOutcome } from '@sibei/api';
import { dur, makeBar, makeNote, makeScore } from '@sibei/model';
import type { Score } from '@sibei/model';

/**
 * Shared fixtures for the store layer.
 *
 * From V2c the store refuses a document write that does not carry the operations that caused it
 * (ADR-0003), so every write in a test needs an operation behind it too. These helpers supply a
 * plausible one, which keeps the store tests about the *store* — versions, owners, migration —
 * rather than about op payloads.
 */

export function anOperation(operation: Operation): StoredOperation {
  return {
    // seq and batch are the store's to assign; a caller choosing its own is a race.
    seq: 0,
    batch: 0,
    version: OPERATION_VERSION,
    operation,
    createdAt: '2026-07-31T09:15:30Z',
  };
}

/** The operation that would have created this score. */
export function creationOf(score: Score): StoredOperation[] {
  return [
    anOperation({
      type: 'score.create',
      payload: {
        id: score.id,
        title: score.meta.title,
        bars: score.bars.map((bar) => ({ id: bar.id, number: bar.number })),
      },
    }),
  ];
}

/** A plausible edit, for a write whose content is beside the point. */
export function anEdit(): StoredOperation[] {
  return [anOperation({ type: 'meta.set', payload: { style: 'Medium swing' } })];
}

export function insert(store: ScoreStore, owner: string, score: Score): WriteOutcome {
  return store.create(owner, score, creationOf(score));
}

export function update(
  store: ScoreStore,
  owner: string,
  id: string,
  expectedVersion: number,
  score: Score,
): WriteOutcome {
  return store.commit(owner, id, expectedVersion, score, anEdit());
}

export function aScore(id = 'score-1', title = 'Body and Soul'): Score {
  const bar = makeBar({
    id: 'bar-1',
    number: 1,
    items: [makeNote({ id: 'note-1', onset: 0, duration: dur(1), pitch: 'Eb5' })],
  });
  return makeScore({
    id,
    title,
    composer: 'Johnny Green',
    key: { tonic: 'D', alter: -1, mode: 'major' },
    bars: [bar],
  });
}
