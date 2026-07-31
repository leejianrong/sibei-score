import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0006 puts binary artefacts behind a `BlobStore` interface with a local directory behind
 * that, for the same reason the scores went behind a repository: the hosted transition is a
 * change of implementation and not a rewrite (R8). That claim holds only while nothing above the
 * implementation knows a filesystem exists.
 *
 * The sibling of `store-seam.test.ts`, and scoped the way that one is not. SQLite may be named
 * nowhere in the tree; the filesystem may be named in `packages/cli` (the store path is a CLI
 * argument) and throughout `scripts/` (development entry points, not product surface). The claim
 * worth asserting is therefore about `packages/api` — the server side, the thing that gets
 * deployed, and the package whose portability the ADR is actually about.
 */

const REPO = resolve(import.meta.dirname, '../..');

/** The only file permitted to know. Exactly one, and a second has to show up in a diff. */
const THE_IMPLEMENTATION = 'packages/api/src/blob/directory-blob-store.ts';

/** The port itself, which must stay an interface and nothing more. */
const THE_PORT = 'packages/api/src/blob/blob-store.ts';

/** Where the export path lives, and what it must go through to store its bytes. */
const THE_EXPORTER = 'packages/api/src/export/export.ts';

const FILESYSTEM_MODULES = ['node:fs', 'node:fs/promises', 'node:path', 'node:os', 'fs', 'path', 'os'];

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
 * Code with the comments taken out. Explaining in a comment *why* the port exists, and naming the
 * thing it hides, is not a dependency on it — the same allowance the store seam makes.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/** Every source file in the server-side package, repo-relative. */
function apiFiles(): string[] {
  return sourceFiles(join(REPO, 'packages/api/src')).map((file) => relative(REPO, file));
}

describe('the blob seam (ADR-0006)', () => {
  it('has the files it claims to have', () => {
    // Guards the guard: a rename would otherwise turn every assertion below into a tautology.
    for (const file of [THE_IMPLEMENTATION, THE_PORT, THE_EXPORTER]) {
      expect(exists(join(REPO, file))).toBe(true);
    }
  });

  it('has api source to check', () => {
    expect(apiFiles().length).toBeGreaterThan(0);
  });

  it('lets nothing else in packages/api import a filesystem module', () => {
    const importPattern = new RegExp(
      `(?:from|import)\\s*\\(?\\s*['"](?:${FILESYSTEM_MODULES.map(escape).join('|')})['"]`,
    );
    const offenders = apiFiles().filter(
      (file) => file !== THE_IMPLEMENTATION && importPattern.test(codeOf(join(REPO, file))),
    );
    expect(offenders).toEqual([]);
  });

  it('lets nothing else in packages/api touch a file by any other route', () => {
    // Importing the module is the obvious leak. A destructured `fs` off a dynamic import, or a
    // reach through `process.cwd()` into a path, is the subtle one.
    const reach = /\b(readFile|readFileSync|writeFile|writeFileSync|appendFile|mkdir|mkdirSync|createReadStream|createWriteStream|unlink|rename|renameSync|process\.cwd)\b/;
    const offenders = apiFiles().filter(
      (file) => file !== THE_IMPLEMENTATION && reach.test(codeOf(join(REPO, file))),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the port an interface, with no implementation in it to reach past', () => {
    const port = codeOf(join(REPO, THE_PORT));
    expect(port).toMatch(/interface BlobStore/);
    expect(port).not.toMatch(/(?:from|import)\s*\(?\s*['"]/);
    // No delete: Q81's cache has no invalidation logic, so the port offers nowhere to put any.
    const surface = /interface BlobStore \{[\s\S]*?\n\}/.exec(port)?.[0] ?? '';
    expect(surface).toBeTruthy();
    expect(surface).not.toMatch(/\b(delete|remove|clear|evict|invalidate)\s*\(/);
  });

  it('makes the export path go through the port rather than around it', () => {
    // The acceptance criterion for V3a, asserted structurally: export reads through the
    // repository and writes through the BlobStore, and holds no path of its own.
    const exporter = codeOf(join(REPO, THE_EXPORTER));
    expect(exporter).toMatch(/\bBlobStore\b/);
    expect(exporter).toMatch(/\bScoreReader\b/);
    expect(exporter).toMatch(/blobs\.put\(/);
    expect(exporter).toMatch(/blobs\.get\(/);
  });

  it('keeps invalidation logic out of the export path entirely (Q81)', () => {
    // The key is (score version, format, instrument). A version bump invalidates implicitly, and
    // the only correct amount of invalidation logic is none — so there is none to find.
    const exporter = codeOf(join(REPO, THE_EXPORTER));
    expect(exporter).not.toMatch(/\b(invalidate|evict|purge|expire)\b/i);
    expect(exporter).toMatch(/version/);
  });

  it('takes a directory as a parameter, never a path baked into the package', () => {
    // `packages/api` takes a port or a parameter and never names a location (ADR-0001). A default
    // here would be a host path in the server-side package, which is what the CLI is for.
    const implementation = codeOf(join(REPO, THE_IMPLEMENTATION));
    expect(implementation).toMatch(/directory: string/);
    expect(implementation).not.toMatch(/homedir|XDG_|process\.env/);
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
