import { describe, expect, it } from 'vitest';
import { OwnerGoneError, guardLanding } from '../../packages/api/src/account/landing.js';

/**
 * SIB2-202: the landing guard, with the owner vanishing at each of the two moments it can.
 */
describe('guardLanding', () => {
  const doc = { id: 'import-1' } as never;

  function harness(existsAnswers: boolean[]) {
    const deleted: string[] = [];
    let writes = 0;
    const guarded = guardLanding(
      { import: async () => ((writes += 1), { scoreId: 'import-1', version: 1 }) } as never,
      async () => existsAnswers.shift() ?? false,
      { delete: async (_owner, id) => (deleted.push(id), true) },
    );
    return { guarded, deleted, writes: () => writes };
  }

  it('lands for an owner that exists', async () => {
    const h = harness([true, true]);
    await expect(h.guarded.import('u', doc)).resolves.toEqual({ scoreId: 'import-1', version: 1 });
    expect(h.deleted).toEqual([]);
  });

  it('writes nothing for an owner already gone', async () => {
    const h = harness([false]);
    await expect(h.guarded.import('u', doc)).rejects.toBeInstanceOf(OwnerGoneError);
    expect(h.writes()).toBe(0);
  });

  it('removes the draft it just wrote when the owner vanished during the write', async () => {
    const h = harness([true, false]);
    await expect(h.guarded.import('u', doc)).rejects.toBeInstanceOf(OwnerGoneError);
    expect(h.deleted).toEqual(['import-1']);
  });
});
