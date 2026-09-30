import { describe, expect, it } from 'vitest';
import { LOCAL_OWNER } from '@sibei/api';
import { openSqliteJobStore, openSqliteStore } from '@sibei/api/sqlite';

/**
 * The runtime half of `tests/arch/async-ports.test.ts` (V18, ADR-0034). The type-level check proves
 * the ports are *declared* asynchronous; this proves the SQLite adapters, which wrap a synchronous
 * driver, really return promises — including for a write that throws, which must surface as a
 * rejection rather than escaping synchronously (a caller that only `await`s inside a `try` would
 * otherwise miss it). Infra layer: it opens a real database.
 */
describe('the SQLite adapters are asynchronous', () => {
  it('reads and lifecycle calls return promises', async () => {
    const store = openSqliteStore({ filename: ':memory:' });
    const jobs = openSqliteJobStore({ filename: ':memory:' });
    try {
      for (const result of [
        store.list(LOCAL_OWNER),
        store.get(LOCAL_OWNER, 'nope'),
        store.exists(LOCAL_OWNER, 'nope'),
        store.operations(LOCAL_OWNER, 'nope'),
        store.delete(LOCAL_OWNER, 'nope'),
        jobs.list(LOCAL_OWNER),
        jobs.claim(),
        jobs.recover('test'),
      ]) {
        expect(result).toBeInstanceOf(Promise);
        await result;
      }
    } finally {
      await store.close();
      await jobs.close();
    }
  });

  it('a write the store refuses is a rejection, never a synchronous throw', async () => {
    const store = openSqliteStore({ filename: ':memory:' });
    const jobs = openSqliteJobStore({ filename: ':memory:' });
    try {
      // `create` with no operations is refused (ADR-0003); an import job with no images likewise.
      let pending: Promise<unknown> | undefined;
      expect(() => {
        pending = store.create(LOCAL_OWNER, {} as never, []);
      }).not.toThrow();
      await expect(pending).rejects.toThrow(/must carry the operations/);

      expect(() => {
        pending = jobs.create(LOCAL_OWNER, []);
      }).not.toThrow();
      await expect(pending).rejects.toThrow(/at least one image/);
    } finally {
      await store.close();
      await jobs.close();
    }
  });
});
