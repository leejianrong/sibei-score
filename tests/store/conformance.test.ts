import { openSqliteJobStore, openSqliteStore } from '@sibei/api/sqlite';
import { jobStoreConformance, storeConformance } from './conformance.js';
import type { OpenHarness } from './conformance.js';

/**
 * The SQLite adapters against the shared store contract (V19). The Postgres run of the same suite is
 * `tests/postgres/conformance.test.ts`; keeping the contract in one module is what stops them drifting.
 * `:memory:` is a database per connection, which suits a contract that never needs the two stores to see
 * each other's tables.
 */
const open: OpenHarness = async (options = {}) => {
  const store = openSqliteStore({
    filename: ':memory:',
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
  });
  const jobs = openSqliteJobStore({ filename: ':memory:', ...(options.now === undefined ? {} : { now: options.now }) });
  return {
    store,
    jobs,
    async close() {
      await store.close();
      await jobs.close();
    },
  };
};

storeConformance('sqlite', open);
jobStoreConformance('sqlite', open);
