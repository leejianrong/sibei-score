import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0006 put the store behind a repository interface, and the entire argument for the
 * interface was that the hosted transition is a change of implementation and not a rewrite
 * (R8). That is only true while nothing above the implementation knows SQLite exists.
 *
 * "Genuinely swappable" is the kind of claim that stays true for exactly as long as somebody
 * is checking, because reaching for a statement directly is always the shortest path in the
 * moment and nobody notices until the migration. So it is asserted here rather than intended.
 */

const REPO = resolve(import.meta.dirname, '../..');

/**
 * The only files permitted to know, per driver. Short lists, and the length is the point — another file
 * has to show up in a diff and be argued for.
 *
 * Two drivers since V19 (ADR-0034). The seam is *per driver*: a Postgres file may not import SQLite's
 * driver and vice versa, so neither adapter can quietly grow a dependency on the other's world, and a
 * third database would add a third list rather than widen these.
 */
const SQLITE_IMPLEMENTATION = [
  'packages/api/src/store/sqlite-store.ts',
  'packages/api/src/store/sqlite-schema.ts',
  // The third, argued for (V10): the import-job queue is durable state (ADR-0001 #7), so it needs a
  // real adapter behind the `JobStore` port. It is a separate file — and a separate connection to
  // the same database — rather than more methods on `sqlite-store.ts`, because a mutable job is not
  // the append-only op log that file guards (ADR-0003). See its header.
  'packages/api/src/store/sqlite-jobs.ts',
];

/**
 * The Postgres adapter (V19): the schema and migration, the transaction/session helper that names the
 * owner for row-level security, the score store and the job store. Four files, each argued in its header;
 * `postgres-session.ts` is the fourth because both stores must run every statement the same way.
 */
const POSTGRES_IMPLEMENTATION = [
  'packages/api/src/store/postgres-schema.ts',
  'packages/api/src/store/postgres-session.ts',
  'packages/api/src/store/postgres-store.ts',
  'packages/api/src/store/postgres-jobs.ts',
];

const THE_IMPLEMENTATION = [...SQLITE_IMPLEMENTATION, ...POSTGRES_IMPLEMENTATION];

const DRIVERS = [
  { name: 'better-sqlite3', may: SQLITE_IMPLEMENTATION },
  { name: 'pg', may: POSTGRES_IMPLEMENTATION },
];

function sourceFiles(directory: string): string[] {
  if (!exists(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith('.ts')) found.push(path);
  }
  return found;
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Code with the comments taken out. Explaining in a comment *why* the port exists, and naming
 * the thing it hides, is not a dependency on it — same reason the draw-seam test does this.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/** Every source file the product ships or builds with, repo-relative. */
function productFiles(): string[] {
  return [...sourceFiles(join(REPO, 'packages')), ...sourceFiles(join(REPO, 'scripts'))].map(
    (file) => relative(REPO, file),
  );
}

describe('the store seam (ADR-0006)', () => {
  it('has the implementation it claims to have', () => {
    // Guards the guard: a rename would otherwise turn every assertion below into a tautology
    // over an empty allowlist.
    for (const file of THE_IMPLEMENTATION) expect(exists(join(REPO, file))).toBe(true);
  });

  it('lets nothing outside a driver\'s own files import that driver', () => {
    for (const driver of DRIVERS) {
      const offenders = productFiles().filter(
        (file) =>
          !driver.may.includes(file) &&
          new RegExp(`['"]${driver.name}(/[^'"]*)?['"]`).test(codeOf(join(REPO, file))),
      );
      expect({ driver: driver.name, offenders }).toEqual({ driver: driver.name, offenders: [] });
    }
  });

  it('keeps the two adapters out of each other\'s worlds', () => {
    // A Postgres file naming SQLite's driver (or the reverse) would mean one adapter had started to
    // depend on the other, which is exactly the coupling the port exists to prevent.
    for (const file of POSTGRES_IMPLEMENTATION) {
      expect(codeOf(join(REPO, file))).not.toMatch(/['"]better-sqlite3['"]/);
    }
    for (const file of SQLITE_IMPLEMENTATION) {
      expect(codeOf(join(REPO, file))).not.toMatch(/from ['"]pg['"]/);
    }
  });

  it('lets nothing outside the implementation write SQL', () => {
    // Importing the driver is the obvious leak; a raw statement handed to something else is
    // the subtle one.
    const sql = /\b(SELECT\s|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|CREATE\s+INDEX|PRAGMA\s)/i;
    const offenders = productFiles().filter(
      (file) => !THE_IMPLEMENTATION.includes(file) && sql.test(codeOf(join(REPO, file))),
    );
    expect(offenders).toEqual([]);
  });

  it('is the only package that declares either driver', () => {
    for (const isDriver of [(dep: string) => dep.includes('sqlite'), (dep: string) => dep === 'pg' || dep === '@types/pg']) {
      const declaring = readdirSync(join(REPO, 'packages')).filter((name) => {
        const manifest = join(REPO, 'packages', name, 'package.json');
        if (!exists(manifest)) return false;
        const { dependencies, devDependencies } = JSON.parse(readFileSync(manifest, 'utf8')) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        return Object.keys({ ...dependencies, ...devDependencies }).some(isDriver);
      });
      expect(declaring).toEqual(['api']);
    }
  });

  it('keeps the driver out of the root manifest, so no test can reach past the port', () => {
    // A test that inspects a column directly would be the second thing in the tree that knows
    // SQLite exists, and it would be the one nobody thinks of as production code. Not having
    // the driver available at the root is what makes that impossible rather than discouraged.
    const { dependencies, devDependencies } = JSON.parse(
      readFileSync(join(REPO, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = Object.keys({ ...dependencies, ...devDependencies });
    expect(declared.filter((dep) => dep.includes('sqlite') || dep === 'pg' || dep === '@types/pg')).toEqual([]);
  });
});
