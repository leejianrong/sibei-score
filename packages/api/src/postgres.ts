/**
 * The Postgres adapter, as an opt-in subpath (V19, ADR-0034): `@sibei/api/postgres`.
 *
 * The sibling of `./sqlite`, and for the same reason it is not re-exported from the package barrel:
 * importing `@sibei/api` for the pure reducer or the routes must not bring a database driver along, and
 * `tests/arch/fast-layer-purity.test.ts` asserts it. Only the process that actually serves against
 * Postgres names this path.
 */
export { openPostgresStore } from './store/postgres-store.js';
export type { PostgresStoreOptions } from './store/postgres-store.js';
export { openPostgresJobStore } from './store/postgres-jobs.js';
export type { PostgresJobStoreOptions } from './store/postgres-jobs.js';
export { openPostgresAudioJobStore } from './store/postgres-audio-jobs.js';
export type { PostgresAudioJobStoreOptions } from './store/postgres-audio-jobs.js';
export { openPostgresAuthStore } from './store/postgres-auth.js';
export type { PostgresAuthStoreOptions } from './store/postgres-auth.js';
export { POSTGRES_TABLE_SCHEMA_VERSION } from './store/postgres-schema.js';
export { openPostgresBlobLedger } from './store/postgres-blobs.js';
export type { PostgresBlobLedgerOptions } from './store/postgres-blobs.js';
