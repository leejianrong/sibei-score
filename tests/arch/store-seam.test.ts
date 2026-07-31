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
 * The only files permitted to know. Exactly two, and the list being short is the point — a
 * third one has to show up in a diff and be argued for.
 */
const THE_IMPLEMENTATION = ['packages/api/src/store/sqlite-store.ts', 'packages/api/src/store/sqlite-schema.ts'];

const DRIVER = 'better-sqlite3';

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

  it('lets nothing outside the implementation import the driver', () => {
    const offenders = productFiles().filter(
      (file) =>
        !THE_IMPLEMENTATION.includes(file) &&
        new RegExp(`['"]${DRIVER}(/[^'"]*)?['"]`).test(codeOf(join(REPO, file))),
    );
    expect(offenders).toEqual([]);
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

  it('is the only package that declares the driver', () => {
    const declaring = readdirSync(join(REPO, 'packages')).filter((name) => {
      const manifest = join(REPO, 'packages', name, 'package.json');
      if (!exists(manifest)) return false;
      const { dependencies, devDependencies } = JSON.parse(readFileSync(manifest, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return Object.keys({ ...dependencies, ...devDependencies }).some((dep) =>
        dep.includes('sqlite'),
      );
    });
    expect(declaring).toEqual(['api']);
  });

  it('keeps the driver out of the root manifest, so no test can reach past the port', () => {
    // A test that inspects a column directly would be the second thing in the tree that knows
    // SQLite exists, and it would be the one nobody thinks of as production code. Not having
    // the driver available at the root is what makes that impossible rather than discouraged.
    const { dependencies, devDependencies } = JSON.parse(
      readFileSync(join(REPO, 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const declared = Object.keys({ ...dependencies, ...devDependencies });
    expect(declared.filter((dep) => dep.includes('sqlite'))).toEqual([]);
  });
});
