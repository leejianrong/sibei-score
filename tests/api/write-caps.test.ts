import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_OWNER, OperationError, createApplier, writeCapsFromEnv } from '@sibei/api';
import { openSqliteStore } from '@sibei/api/sqlite';
import type { Operation, ScoreStore } from '@sibei/api';

/** SEC H1: a new write has a size; an old log does not (ADR-0028). */

const stores: ScoreStore[] = [];
afterEach(async () => {
  while (stores.length > 0) await stores.pop()?.close();
});

const caps = { maxOpsPerBatch: 5, maxBarsPerScore: 20, maxItemsPerBar: 3 };

async function chart() {
  const store = openSqliteStore({ filename: ':memory:' });
  stores.push(store);
  const applier = createApplier(store, undefined, caps);
  await applier.apply(LOCAL_OWNER, null, { operations: [{ type: 'score.create', payload: { id: 'c', barCount: 4 } }] });
  return { store, applier };
}

const refused = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    return (error as OperationError).message;
  }
  throw new Error('expected a refusal');
};

describe('write caps', () => {
  it('refuses a batch over the op cap before folding anything', async () => {
    const { applier, store } = await chart();
    const ops: Operation[] = Array.from({ length: 6 }, () => ({ type: 'bar.add', payload: { count: 1 } }));
    expect(await refused(applier.apply(LOCAL_OWNER, 'c', { operations: ops, expectedVersion: 1 }))).toMatch(/capped at 5 operations/);
    expect((await store.get(LOCAL_OWNER, 'c'))!.score.bars).toHaveLength(4);
  });

  it('refuses bar.add that would pass the bar cap, and a create asking for too many bars', async () => {
    const { applier } = await chart();
    const big: Operation[] = [{ type: 'bar.add', payload: { count: 1000 } }];
    expect(await refused(applier.apply(LOCAL_OWNER, 'c', { operations: big, expectedVersion: 1 }))).toMatch(/capped at 20 bars/);
    const create: Operation[] = [{ type: 'score.create', payload: { id: 'huge', barCount: 21 } }];
    expect(await refused(applier.apply(LOCAL_OWNER, null, { operations: create }))).toMatch(/capped at 20 bars/);
  });

  it('allows a batch within the caps', async () => {
    const { applier } = await chart();
    const ok = await applier.apply(LOCAL_OWNER, 'c', { operations: [{ type: 'bar.add', payload: { count: 10 } }], expectedVersion: 1 });
    expect(ok.version).toBe(2);
  });

  it('reads caps from the environment and names a bad one', () => {
    expect(writeCapsFromEnv({ SBSCORE_CAP_OPS_PER_BATCH: '9' }).maxOpsPerBatch).toBe(9);
    expect(() => writeCapsFromEnv({ SBSCORE_CAP_BARS_PER_SCORE: 'x' })).toThrow(/SBSCORE_CAP_BARS_PER_SCORE/);
  });
});
