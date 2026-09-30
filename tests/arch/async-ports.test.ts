import { describe, expect, expectTypeOf, it } from 'vitest';
import { LOCAL_OWNER, memoryJobStore, resolveLocalPrincipal } from '@sibei/api';
import type { Authenticator, JobStore, ScoreStore } from '@sibei/api';

/**
 * Every persistence port is asynchronous (V18, ADR-0034).
 *
 * The store, job and auth ports were first drawn around SQLite's synchronous driver, so a caller
 * could use a result the instant it was returned. Every Postgres driver is promise-based (a query is
 * a network round-trip), so the hosted adapter cannot honour a synchronous port — and a port that is
 * *partly* synchronous is worse than either, because the next method added would quietly reintroduce
 * the coupling. So this is asserted, not intended: no method on these ports may return a plain value.
 *
 * The check is a type-level one, so the `tsc -p tests` in `pnpm typecheck` is what enforces it (a
 * vitest `expectTypeOf` is a no-op at runtime by design). The runtime assertion below is a backstop
 * that the fast-layer adapters actually hand back promises rather than merely being typed as if.
 */

/** The names of a port's methods whose return type is *not* a promise. Must be `never`. */
type SyncMethods<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => infer R ? (R extends PromiseLike<unknown> ? never : K) : never;
}[keyof T];

describe('the persistence ports are asynchronous', () => {
  it('no ScoreStore method (reader, writer, library, close) returns synchronously', () => {
    expectTypeOf<SyncMethods<ScoreStore>>().toEqualTypeOf<never>();
  });

  it('no JobStore method (reader, writer, close) returns synchronously', () => {
    expectTypeOf<SyncMethods<JobStore>>().toEqualTypeOf<never>();
  });

  it('the Authenticator resolves a principal asynchronously', () => {
    expectTypeOf<ReturnType<Authenticator>>().toEqualTypeOf<Promise<{ owner: string } | null>>();
  });

  it('the type-level check can fail: a synchronous method is caught', () => {
    // Guards the guard. If `SyncMethods` were vacuous (say, it returned `never` for everything), the
    // three assertions above would pass forever and prove nothing.
    interface Leaky {
      fine(): Promise<number>;
      leaky(): number;
    }
    expectTypeOf<SyncMethods<Leaky>>().toEqualTypeOf<'leaky'>();
  });

  it('the in-memory job store and the local authenticator return promises, not merely typed ones', async () => {
    // The SQLite adapters get the same runtime check in `tests/store/async-adapters.test.ts`; the fast
    // layer may not open a native database (see `tests/arch/layers`).
    const jobs = memoryJobStore();
    for (const result of [jobs.list(LOCAL_OWNER), jobs.claim(), resolveLocalPrincipal({} as never)]) {
      expect(result).toBeInstanceOf(Promise);
      await result;
    }
    await jobs.close();
  });
});
