import { openPostgresJobStore, openPostgresStore } from '@sibei/api/postgres';
import { jobStoreConformance, storeConformance } from '../store/conformance.js';
import type { OpenHarness } from '../store/conformance.js';
import { provisionDatabase, quiet } from './support.js';

/**
 * The Postgres adapters against the shared store contract (V19, ADR-0034) — the very module
 * `tests/store/conformance.test.ts` runs against SQLite. Every test gets a database of its own, owned by
 * a role row-level security actually binds (see `support.ts`), so a pass here means the adapters honour
 * the port *with the backstop switched on*.
 */
const open: OpenHarness = async (options = {}) => {
  const database = await provisionDatabase();
  const clock = options.now === undefined ? {} : { now: options.now };
  const store = await openPostgresStore({
    connectionString: database.url,
    onError: quiet,
    ...clock,
    ...(options.migrate === undefined ? {} : { migrate: options.migrate }),
  });
  const jobs = await openPostgresJobStore({ connectionString: database.url, onError: quiet, ...clock });
  return {
    store,
    jobs,
    async close() {
      await store.close();
      await jobs.close();
      await database.drop();
    },
  };
};

storeConformance('postgres', open);
jobStoreConformance('postgres', open);
