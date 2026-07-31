import type { Database } from 'better-sqlite3';

/**
 * The database's own schema, and its own version.
 *
 * Two versionings live in this slice and they are not the same thing:
 *
 *   - **The document's** `schemaVersion` (ADR-0028) versions the JSON in the `doc` column.
 *     Forward-only, migrated on read, and the interesting one — it is where the musical
 *     shape lives, which the table schema says nothing about.
 *   - **The table's** version, below, versions the DDL. It exists because a table also
 *     changes shape eventually, and `PRAGMA user_version` is the cheapest honest place to
 *     record which one you are looking at.
 *
 * ADR-0028 rejected "version the SQLite schema only" as insufficient. It did not reject
 * doing both, and doing neither would mean guessing.
 */

export const TABLE_SCHEMA_VERSION = 1;

/**
 * ADR-0006 writes the table as `scores(id, owner, title, composer, key, updated_at,
 * version, doc JSON)`. `doc` is declared TEXT rather than the ADR's shorthand `JSON`:
 * SQLite has no JSON affinity, so `JSON` would silently mean NUMERIC. The `json_valid`
 * check is what the shorthand was actually asking for, and it maps onto Postgres `jsonb`
 * unchanged when the hosted transition happens.
 *
 * `key` is the *listing* column — the compact key name, so the library view does not have
 * to deserialise every chart to draw a list. `doc` is the truth.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS scores (
  id          TEXT    NOT NULL PRIMARY KEY,
  owner       TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  composer    TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  doc         TEXT    NOT NULL CHECK (json_valid(doc))
);

-- Every read filters on owner (ADR-0001), so every index leads with it.
CREATE INDEX IF NOT EXISTS scores_owner_updated ON scores (owner, updated_at DESC);
`;

/**
 * Bring a connection up to `TABLE_SCHEMA_VERSION`. Idempotent, so opening an existing
 * database is the same call as creating one.
 *
 * A database from a *newer* table version is a hard error for the same reason a newer
 * document is (ADR-0028): the alternative is reading a shape you do not understand.
 */
export function migrateTables(db: Database): void {
  const found = currentTableVersion(db);
  if (found > TABLE_SCHEMA_VERSION) {
    throw new Error(
      `store is at table schema version ${found}, but this build only understands ` +
        `${TABLE_SCHEMA_VERSION}. Refusing to open it.`,
    );
  }

  // WAL is the right journal for a local single-writer app, and foreign keys are off by
  // default in SQLite for backwards compatibility, which is never what anyone wants.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(DDL);
  db.pragma(`user_version = ${TABLE_SCHEMA_VERSION}`);
}

export function currentTableVersion(db: Database): number {
  const rows = db.pragma('user_version') as { user_version: number }[];
  return rows[0]?.user_version ?? 0;
}
