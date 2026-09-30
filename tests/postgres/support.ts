import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

/**
 * Provisioning for the Postgres tests (V19, ADR-0034). Not a test file.
 *
 * `SBSCORE_TEST_DATABASE_URL` names a Postgres server *as a superuser*; it is only used to create and
 * drop databases and the application role. Each caller gets a **database of its own**, owned by an
 * ordinary `sibei_app` role that is `NOSUPERUSER NOBYPASSRLS`. That role is the point: row-level
 * security does not bind a superuser, so a test that ran the adapters as one would pass while proving
 * nothing about the backstop. The adapters themselves refuse to run as such a role.
 *
 * The URL is required, and a missing one is an error, not a skip — a suite that quietly runs nothing
 * when its database is absent reports green and protects nothing. `pnpm test:postgres` supplies one
 * (starting a container if it has to); CI provides one from a service container.
 *
 * `pg` is resolved through `packages/api`, the only package that depends on it, so the driver stays the
 * API's alone (`tests/arch/store-seam.test.ts` keeps it out of the root manifest).
 */

export interface PgResult {
  rows: Array<Record<string, unknown>>;
  rowCount: number | null;
}
export interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<PgResult>;
  end(): Promise<void>;
}
export interface PgPool {
  on(event: 'error', listener: () => void): unknown;
  query(sql: string, params?: unknown[]): Promise<PgResult>;
  connect(): Promise<PgClient & { release(): void }>;
  end(): Promise<void>;
}
interface PgModule {
  Client: new (config: { connectionString: string }) => PgClient;
  Pool: new (config: { connectionString: string; max?: number }) => PgPool;
}

export const pg = createRequire(resolve(import.meta.dirname, '../../packages/api/package.json'))('pg') as PgModule;

/**
 * The error listener the tests give their pools. `DROP DATABASE … WITH (FORCE)` runs the moment a test's
 * pools are closed, and `pool.end()` resolves once it has *asked* each client to terminate, not once the
 * sockets are gone — so the server can legitimately cut a connection mid-close, and `pg` reports it as an
 * `error` event. That is expected teardown noise, not a failure, so it is swallowed here (and only here).
 */
export const quiet = (): void => {};

export const APP_ROLE = 'sibei_app';
const APP_PASSWORD = 'sibei_app';

export function adminUrl(): string {
  const url = process.env.SBSCORE_TEST_DATABASE_URL;
  if (url === undefined || url === '') {
    throw new Error(
      'SBSCORE_TEST_DATABASE_URL is not set. These tests need a Postgres server (as a superuser); run ' +
        '`pnpm test:postgres`, which starts one with Docker Compose, or point the variable at your own.',
    );
  }
  return url;
}

export interface TestDatabase {
  /** The application role's URL: what the adapters connect with. */
  url: string;
  /** A superuser's URL to *this* database, for inspecting or altering things the app role cannot. */
  superuserUrl: string;
  name: string;
  drop(): Promise<void>;
}

function withDatabase(base: string, database: string, credentials?: { user: string; password: string }): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (credentials !== undefined) {
    url.username = credentials.user;
    url.password = credentials.password;
  }
  return url.toString();
}

export async function provisionDatabase(): Promise<TestDatabase> {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  const name = `sibei_test_${randomBytes(6).toString('hex')}`;
  try {
    // Several test files provision at once, so creating the shared role is a race; the loser's
    // duplicate is exactly the outcome wanted.
    await admin.query(`
      DO $$ BEGIN
        CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${APP_PASSWORD}';
      EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
      END $$`);
    // A locale-aware default collation, on purpose. A bare cluster is often `C`/`C.UTF-8`, where the
    // default *is* byte order, so a query that forgot `COLLATE "C"` would sort exactly like SQLite and the
    // conformance suite's byte-order test could never fail. Production databases are typically locale
    // aware (`en_US.UTF-8`), so the tests run under that: ICU `en-US`, which does not depend on which OS
    // locales the server has installed. (`tests/postgres/postgres.test.ts` asserts this took effect.)
    await admin.query(
      `CREATE DATABASE "${name}" OWNER ${APP_ROLE} TEMPLATE template0 ENCODING 'UTF8' ` +
        `LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'C'`,
    );
  } finally {
    await admin.end();
  }
  return {
    name,
    url: withDatabase(adminUrl(), name, { user: APP_ROLE, password: APP_PASSWORD }),
    superuserUrl: withDatabase(adminUrl(), name),
    async drop() {
      const dropper = new pg.Client({ connectionString: adminUrl() });
      await dropper.connect();
      try {
        // FORCE, so a pool a failed test forgot to close cannot leave the database behind.
        await dropper.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
