/**
 * The SQLite adapter, behind its own entry point (`@sibei/api/sqlite`).
 *
 * ADR-0006 puts the store behind a port and argues that hosting is a change of implementation
 * and not a rewrite. `index.ts` exports the port; this file is the only way to reach the one
 * implementation of it that exists today, and it is the only entry point in the package that
 * loads a compiled native binding.
 *
 * That separation is what makes the suite's `fast` layer honest (KAN-514). The layers are split
 * by *what a test needs in order to run* (`vitest.config.ts`), and while `openSqliteStore` was
 * re-exported from the barrel, importing `@sibei/api` for the pure reducer pulled better-sqlite3
 * in with it — so the layer defined as needing nothing installed needed a compiled module. The
 * package's exports now express the seam the architecture already had.
 *
 * A composition root naming this path is the point, not a leak: choosing the adapter is exactly
 * what a composition root is for, and `openSqliteStore` named SQLite out loud already.
 */

export { openSqliteStore } from './store/sqlite-store.js';
export type { SqliteStoreOptions } from './store/sqlite-store.js';
export { TABLE_SCHEMA_VERSION } from './store/sqlite-schema.js';
