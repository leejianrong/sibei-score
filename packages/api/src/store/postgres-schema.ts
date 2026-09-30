import type { Pool, PoolClient } from 'pg';

/**
 * The Postgres schema, its version, and the migration that brings a database up to it (V19, ADR-0034).
 *
 * **This is one of only four files that may know Postgres exists** (with `postgres-session.ts`,
 * `postgres-store.ts` and `postgres-jobs.ts`); `tests/arch/store-seam.test.ts` holds it, the sibling of the SQLite seam.
 *
 * The shape is the SQLite adapter's table schema v5 (`sqlite-schema.ts`): the same columns, and
 * ownership in the keys — `scores` is keyed `(owner, id)` and `operations` carries the owner with a
 * composite foreign key — so a chart id is unique per owner and an id collision is only ever reported
 * against your own library. Two things differ, both deliberately:
 *
 *   - **`doc`, `payload`, `image_keys` and `result` are `text`, not `jsonb`.** A `jsonb` round-trip
 *     reorders keys and normalises numbers, so the document read back would no longer be the bytes that
 *     were written. That matters here: the export cache key is a digest of the serialised document (Q81),
 *     and the log must return "whatever was written" so undo can replay it (ADR-0028). Validity is still
 *     enforced, by a `CHECK` that the text parses as JSON, so the guarantee is the one SQLite's
 *     `json_valid` gives. Moving to `jsonb` later is a forward migration if a query ever needs inside the
 *     document; nothing does today.
 *   - **Row-level security backs every owner filter** (below).
 *
 * The table version here is this adapter's own lineage, starting at 1; it is unrelated to SQLite's
 * `TABLE_SCHEMA_VERSION` and to the document's `schemaVersion` (ADR-0028). It is recorded in
 * `schema_meta` rather than a pragma, since Postgres has none.
 */

export const POSTGRES_TABLE_SCHEMA_VERSION = 1;

/**
 * Row-level security is the backstop for a missed `WHERE owner = …` (ADR-0034 decision 2, hosting.md).
 * Every table is `ENABLE`d *and* `FORCE`d, so it binds the table's owner too — the role the application
 * connects as — and the policy compares the row's owner with `app.owner`, a setting the adapter sets
 * with `SET LOCAL` semantics at the start of every transaction. An unset setting reads as NULL, the
 * comparison is NULL, and no row is visible: the default is deny, not allow.
 *
 * `import_jobs` has one extra branch, `app.system = 'on'`. The runner is a system actor that claims the
 * oldest queued job across *all* owners (`JobWriter.claim`), which an owner-only policy could never
 * express. The adapter sets it only for the four methods that are not owner-scoped (`claim`, `complete`,
 * `fail`, `recover`) and never for a request path, so a missed filter in a route still cannot reach
 * another owner's job.
 *
 * None of this binds a superuser or a role with `BYPASSRLS`, which is why `assertRlsEnforced` refuses to
 * run as one: the official `postgres` image's default user is a superuser, and running the application as
 * it would quietly turn the whole backstop off.
 */
const OWNER_POLICY = `owner = current_setting('app.owner', true)`;
const JOB_POLICY = `owner = current_setting('app.owner', true) OR current_setting('app.system', true) = 'on'`;

const TABLES = `
CREATE TABLE IF NOT EXISTS scores (
  owner       text    NOT NULL,
  id          text    NOT NULL,
  title       text    NOT NULL,
  composer    text    NOT NULL,
  key         text    NOT NULL,
  updated_at  text    NOT NULL,
  version     integer NOT NULL,
  doc         text    NOT NULL CHECK ((doc::jsonb) IS NOT NULL),
  PRIMARY KEY (owner, id)
);
CREATE INDEX IF NOT EXISTS scores_owner_updated ON scores (owner, updated_at DESC);

-- The append-only op log (ADR-0003). Nothing updates or deletes a row here; rows go only by cascade
-- when their score does, which is why deleting a score cannot itself be an operation.
CREATE TABLE IF NOT EXISTS operations (
  owner       text    NOT NULL,
  score_id    text    NOT NULL,
  seq         integer NOT NULL,
  batch       integer NOT NULL,
  op_version  integer NOT NULL,
  type        text    NOT NULL,
  payload     text    NOT NULL CHECK ((payload::jsonb) IS NOT NULL),
  created_at  text    NOT NULL,
  PRIMARY KEY (owner, score_id, seq),
  FOREIGN KEY (owner, score_id) REFERENCES scores (owner, id) ON DELETE CASCADE
);

-- The import-job queue (V10). Not in the op log and not a foreign key to scores: a job outlives, and may
-- never produce, a score (Q80), and score_id is a soft back-pointer filled in by the importer.
CREATE TABLE IF NOT EXISTS import_jobs (
  id          text    NOT NULL PRIMARY KEY,
  owner       text    NOT NULL,
  status      text    NOT NULL,
  image_keys  text    NOT NULL CHECK ((image_keys::jsonb) IS NOT NULL),
  engine      text,
  attempts    integer NOT NULL,
  diagnostic  text,
  result      text    CHECK (result IS NULL OR (result::jsonb) IS NOT NULL),
  score_id    text,
  version     integer NOT NULL,
  created_at  text    NOT NULL,
  updated_at  text    NOT NULL
);
CREATE INDEX IF NOT EXISTS import_jobs_owner_created ON import_jobs (owner, created_at DESC);
CREATE INDEX IF NOT EXISTS import_jobs_status_created ON import_jobs (status, created_at ASC);

CREATE TABLE IF NOT EXISTS schema_meta (
  key    text    NOT NULL PRIMARY KEY,
  value  integer NOT NULL
);
`;

const SECURITY = `
ALTER TABLE scores      ENABLE ROW LEVEL SECURITY;
ALTER TABLE scores      FORCE  ROW LEVEL SECURITY;
ALTER TABLE operations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations  FORCE  ROW LEVEL SECURITY;
ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS owner_isolation ON scores;
CREATE POLICY owner_isolation ON scores
  USING (${OWNER_POLICY}) WITH CHECK (${OWNER_POLICY});
DROP POLICY IF EXISTS owner_isolation ON operations;
CREATE POLICY owner_isolation ON operations
  USING (${OWNER_POLICY}) WITH CHECK (${OWNER_POLICY});
DROP POLICY IF EXISTS owner_isolation ON import_jobs;
CREATE POLICY owner_isolation ON import_jobs
  USING (${JOB_POLICY}) WITH CHECK (${JOB_POLICY});
`;

/** Any fixed number: it only has to be the same in every process that migrates this database. */
const MIGRATION_LOCK_KEY = 0x53_49_42_45; // "SIBE"

/**
 * Bring a database up to `POSTGRES_TABLE_SCHEMA_VERSION`. Idempotent, so opening an existing database is
 * the same call as creating one, and safe to call from several processes at once: the whole migration is
 * one transaction under a transaction-scoped advisory lock, so replicas booting together serialise and
 * the second finds the work already done.
 *
 * A database from a *newer* table version is a hard error, for the reason a newer document is
 * (ADR-0028): the alternative is reading a shape this build does not understand.
 */
export async function migratePostgres(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);

    // `schema_meta` is created inside the lock, so the version read below is never a race.
    await client.query(`CREATE TABLE IF NOT EXISTS schema_meta (key text NOT NULL PRIMARY KEY, value integer NOT NULL)`);
    const found = await currentVersion(client);
    if (found > POSTGRES_TABLE_SCHEMA_VERSION) {
      throw new Error(
        `store is at table schema version ${found}, but this build only understands ` +
          `${POSTGRES_TABLE_SCHEMA_VERSION}. Refusing to open it.`,
      );
    }

    await client.query(TABLES);
    await client.query(SECURITY);
    await client.query(
      `INSERT INTO schema_meta (key, value) VALUES ('table_version', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [POSTGRES_TABLE_SCHEMA_VERSION],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function currentVersion(client: PoolClient): Promise<number> {
  const result = await client.query<{ value: number }>(`SELECT value FROM schema_meta WHERE key = 'table_version'`);
  return result.rows[0]?.value ?? 0;
}

/**
 * Refuse to run as a role that row-level security does not bind.
 *
 * A superuser, or a role with `BYPASSRLS`, ignores every policy above, so the backstop would be present
 * in the schema and absent in effect — the worst kind of security control, one that looks like it is
 * working. The official `postgres` image's default user is a superuser, so this is the mistake a
 * first deployment makes. The application should connect as an ordinary role that owns its tables.
 * `allowBypass` is the explicit opt-out, for local development against a throwaway superuser.
 */
export async function assertRlsEnforced(pool: Pool, allowBypass: boolean): Promise<void> {
  const result = await pool.query<{ bypasses: boolean; role: string }>(
    `SELECT (rolsuper OR rolbypassrls) AS bypasses, rolname AS role FROM pg_roles WHERE rolname = current_user`,
  );
  const row = result.rows[0];
  if (row?.bypasses === true && !allowBypass) {
    throw new Error(
      `the database role "${row.role}" is a superuser or has BYPASSRLS, so row-level security would not ` +
        `apply to it and would protect nothing. Connect as an ordinary role that owns the tables ` +
        `(CREATE ROLE sibei_app LOGIN NOSUPERUSER NOBYPASSRLS), or pass allowRlsBypass to opt out ` +
        `knowingly (local development only).`,
    );
  }
}
