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

export const TABLE_SCHEMA_VERSION = 5;

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
  id          TEXT    NOT NULL,
  owner       TEXT    NOT NULL,
  title       TEXT    NOT NULL,
  composer    TEXT    NOT NULL,
  key         TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  version     INTEGER NOT NULL,
  doc         TEXT    NOT NULL CHECK (json_valid(doc)),
  -- Ownership is part of the key (table schema version 5, V19a). Until then \`id\` alone was the primary
  -- key, which is invisible with one owner and wrong with two: two users could not both have a chart
  -- called "soul", and creating an id another owner already held answered \`already-exists\` — telling
  -- one tenant that another tenant's id exists. A chart id is unique *per owner*, and a collision is
  -- only ever reported against your own library.
  PRIMARY KEY (owner, id)
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
  owner       TEXT    NOT NULL,
  score_id    TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  batch       INTEGER NOT NULL,
  op_version  INTEGER NOT NULL,
  type        TEXT    NOT NULL,
  payload     TEXT    NOT NULL CHECK (json_valid(payload)),
  created_at  TEXT    NOT NULL,
  PRIMARY KEY (owner, score_id, seq),
  FOREIGN KEY (owner, score_id) REFERENCES scores (owner, id) ON DELETE CASCADE
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
  -- The recognition engine a re-parse (V14e) asked for, or NULL for the worker default. A normal
  -- import leaves it NULL; the runner threads a non-null value to the worker per-request. Added at
  -- table schema version 4 (see migrateTables), nullable so the ALTER on an existing table needs no
  -- backfill and every V10..V13 job reads as NULL (the worker default, which is what they ran on).
  engine      TEXT,
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

  // The v5 rebuild has to run *before* the DDL: `CREATE TABLE IF NOT EXISTS` would leave a v4 table as
  // it is, and the index it creates over the new shape would then not match the old one.
  if (needsTenancyKeys(db)) rebuildWithTenancyKeys(db);

  db.exec(DDL);

  // Incremental migrations for a database that pre-dates a column. `CREATE TABLE IF NOT EXISTS` above
  // brings a *fresh* database straight to the current shape but does nothing to an existing table, so
  // an added column needs an explicit ALTER. Each step is idempotent (it checks the column is really
  // missing) rather than gated on `found`, because `migrateTables` runs on every open — belt to the
  // `user_version` braces.
  //
  //   v4 (V14e): `import_jobs.engine` — the engine a re-parse asked for; NULL on every older job.
  ensureColumn(db, 'import_jobs', 'engine', 'TEXT');

  db.pragma(`user_version = ${TABLE_SCHEMA_VERSION}`);
}

/**
 * Whether this database still has the pre-v5 shape: a `scores` table whose primary key is `id` alone,
 * with an `operations` table that does not carry an owner. A fresh database has neither table yet and
 * needs no rebuild.
 */
function needsTenancyKeys(db: Database): boolean {
  const has = (table: string): boolean =>
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !== undefined;
  if (!has('scores') || !has('operations')) return false;
  const columns = db.pragma('table_info(operations)') as { name: string }[];
  return !columns.some((column) => column.name === 'owner');
}

/**
 * v4 → v5 (V19a): make ownership part of both keys. SQLite cannot alter a primary key, so this is the
 * documented table rebuild — create the new tables, copy every row across, drop the old, rename — inside
 * one transaction, with foreign keys off for its duration (the rebuild would otherwise trip its own
 * references) and checked before it commits.
 *
 * Nothing is lost or reordered: every score row is copied as it is, and each operation takes its owner
 * from the score it belongs to, keeping its `seq` and `batch`, so undo-by-replay reads the same log it
 * did before. A score's version is untouched — a migration is not an edit (ADR-0028). Every existing row
 * has owner `local`, since nothing else could have written one.
 */
function rebuildWithTenancyKeys(db: Database): void {
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE scores_v5 (
          id TEXT NOT NULL, owner TEXT NOT NULL, title TEXT NOT NULL, composer TEXT NOT NULL,
          key TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL,
          doc TEXT NOT NULL CHECK (json_valid(doc)),
          PRIMARY KEY (owner, id)
        );
        INSERT INTO scores_v5 (id, owner, title, composer, key, updated_at, version, doc)
          SELECT id, owner, title, composer, key, updated_at, version, doc FROM scores;

        CREATE TABLE operations_v5 (
          owner TEXT NOT NULL, score_id TEXT NOT NULL, seq INTEGER NOT NULL, batch INTEGER NOT NULL,
          op_version INTEGER NOT NULL, type TEXT NOT NULL,
          payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL,
          PRIMARY KEY (owner, score_id, seq),
          FOREIGN KEY (owner, score_id) REFERENCES scores (owner, id) ON DELETE CASCADE
        );
        INSERT INTO operations_v5 (owner, score_id, seq, batch, op_version, type, payload, created_at)
          SELECT s.owner, o.score_id, o.seq, o.batch, o.op_version, o.type, o.payload, o.created_at
            FROM operations o JOIN scores s ON s.id = o.score_id;

        DROP TABLE operations;
        DROP TABLE scores;
        ALTER TABLE scores_v5 RENAME TO scores;
        ALTER TABLE operations_v5 RENAME TO operations;
      `);
      const broken = db.pragma('foreign_key_check') as unknown[];
      if (broken.length > 0) {
        throw new Error(`the v5 table rebuild left ${broken.length} dangling reference(s); rolled back`);
      }
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/** Add `column` to `table` if it is not already there. Idempotent, so it is safe on a fresh database
 * (where the DDL already created the column) and on an old one (where the ALTER actually runs). */
function ensureColumn(db: Database, table: string, column: string, type: string): void {
  const columns = db.pragma(`table_info(${table})`) as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function currentTableVersion(db: Database): number {
  const rows = db.pragma('user_version') as { user_version: number }[];
  return rows[0]?.user_version ?? 0;
}
