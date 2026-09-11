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

export const TABLE_SCHEMA_VERSION = 3;

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

-- The operation log: the spine of the system (ADR-0003). Append-only. Nothing updates a row
-- here, and only the op applier inserts one.
--
-- The payload holds the whole normalised operation, so an old operation shape stays readable
-- forever rather than being migrated — undo replays them, so a migration would rewrite history
-- (ADR-0028). op_version is the operation shape's own version and has nothing to do with either
-- the document's schema_version or the score's version.
--
-- ON DELETE CASCADE is the delete semantics: removing a chart removes its log, which is exactly
-- why deleting a score cannot itself be an operation — there would be no log left to put it in.
CREATE TABLE IF NOT EXISTS operations (
  score_id    TEXT    NOT NULL REFERENCES scores (id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  batch       INTEGER NOT NULL,
  op_version  INTEGER NOT NULL,
  type        TEXT    NOT NULL,
  payload     TEXT    NOT NULL CHECK (json_valid(payload)),
  created_at  TEXT    NOT NULL,
  PRIMARY KEY (score_id, seq)
);

-- The import-job queue (V10, ADR-0001: "OMR is a job, not a request"). All job state lives here so
-- the API process stays stateless (ADR-0001 #7) — a queued or running job survives a restart, and
-- the runner recovers an interrupted one on the next boot rather than losing it. It is deliberately
-- NOT in the operation log: an import job is not a mutation of a score, and its result is landed as
-- a score.import op only once V11 maps the recognised objects to a document. Nothing here references
-- the scores table -- a job outlives, and may never produce, a score (Q80: a failed import commits
-- nothing), and score_id is a soft back-pointer filled in by the importer, not a foreign key.
--
--   * image_keys are BlobStore keys for the 1..n uploaded source images, in page order (Q26).
--   * result holds the raw recognised objects (an OmrDocument per image) once succeeded -- this is
--     what V10's demo means by "the raw recognised objects stored". Large, and read only on demand,
--     so the listing query never selects it.
--   * diagnostic carries the human-readable failure reason when status = 'failed' (Q80).
--   * version is optimistic-concurrency, the same idea as a score's: it lets a claim be a
--     conditional write, so the shape survives the hosted transition's real worker pool where two
--     processes could race for one job (docs/hosting.md). Locally there is one process, so it never
--     actually contends -- but the seam is cheaper to build now than to retrofit (ADR-0001).
CREATE TABLE IF NOT EXISTS import_jobs (
  id          TEXT    NOT NULL PRIMARY KEY,
  owner       TEXT    NOT NULL,
  status      TEXT    NOT NULL,
  image_keys  TEXT    NOT NULL CHECK (json_valid(image_keys)),
  attempts    INTEGER NOT NULL,
  diagnostic  TEXT,
  result      TEXT    CHECK (result IS NULL OR json_valid(result)),
  score_id    TEXT,
  version     INTEGER NOT NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

-- Every read filters on owner (ADR-0001), so the listing index leads with it.
CREATE INDEX IF NOT EXISTS import_jobs_owner_created ON import_jobs (owner, created_at DESC);
-- The runner claims the oldest queued job across all owners; this index is that claim's scan.
CREATE INDEX IF NOT EXISTS import_jobs_status_created ON import_jobs (status, created_at ASC);
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
