import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * "The only writes to the store come from the op applier" (ADR-0003, PLAN.md).
 *
 * PLAN.md asks for this to be asserted directly rather than reasoned about, and it is the load-
 * bearing half of "the UI and the CLI can never disagree": the other half is that both surfaces
 * are HTTP clients of one API (ADR-0002), so there is no second write path to police.
 *
 * The assertion is structural rather than textual. Writes live on their own interface,
 * `ScoreWriter`, so a file that never names that type cannot be handed one — a route handler
 * constructed with a `ScoreReader` cannot reach a write path even by mistake. Checking who names
 * the type is therefore checking who *could* write, which is stronger than checking who does.
 */

const REPO = resolve(import.meta.dirname, '../..');

/** Declares the capability, and consumes it. Nothing else may name it. */
const MAY_NAME_THE_WRITER = [
  'packages/api/src/store/repository.ts',
  'packages/api/src/ops/applier.ts',
];

/** Implements the capability, so it holds the statements themselves. */
const THE_IMPLEMENTATION = 'packages/api/src/store/sqlite-store.ts';

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

/** Code with the comments taken out: explaining the rule is not breaking it. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function productFiles(): string[] {
  return [...sourceFiles(join(REPO, 'packages')), ...sourceFiles(join(REPO, 'scripts'))].map(
    (file) => relative(REPO, file),
  );
}

describe('the op applier is the only writer (ADR-0003)', () => {
  it('has the files it claims to have', () => {
    // Guards the guard: a rename would turn every assertion below into a tautology.
    for (const file of [...MAY_NAME_THE_WRITER, THE_IMPLEMENTATION]) {
      expect(exists(join(REPO, file))).toBe(true);
    }
  });

  it('keeps writes on their own interface, separate from reads', () => {
    const port = codeOf(join(REPO, 'packages/api/src/store/repository.ts'));
    expect(port).toMatch(/interface ScoreReader/);
    expect(port).toMatch(/interface ScoreWriter/);
    // If the write methods migrated onto the reader, holding a reader would mean holding a
    // writer, and the whole mechanism would be gone while every test still passed.
    const reader = /interface ScoreReader[^}]*\}/.exec(port)?.[0] ?? '';
    expect(reader).not.toMatch(/\b(create|commit)\s*\(/);
  });

  it('lets nothing but the applier name the write capability', () => {
    const offenders = productFiles().filter(
      (file) => !MAY_NAME_THE_WRITER.includes(file) && /\bScoreWriter\b/.test(codeOf(join(REPO, file))),
    );
    expect(offenders).toEqual([]);
  });

  it('lets nothing but the applier call a commit', () => {
    const offenders = productFiles().filter(
      (file) =>
        file !== 'packages/api/src/ops/applier.ts' &&
        file !== THE_IMPLEMENTATION &&
        /\.commit\s*\(/.test(codeOf(join(REPO, file))),
    );
    expect(offenders).toEqual([]);
  });

  it('routes every document write through a statement that also appends to the log', () => {
    // The two INSERT/UPDATE statements against `scores` live in one file, and each is reached only
    // from a transaction that appends operations. Asserted as a shape here; asserted as behaviour
    // by the store refusing an empty operation list.
    const implementation = codeOf(join(REPO, THE_IMPLEMENTATION));
    expect(implementation).toMatch(/refuseEmpty\(operations\)/);
    // Both writers are transactions, so a document and its operations land together or not at all.
    expect(implementation).toMatch(/create: db\.transaction/);
    expect(implementation).toMatch(/commit: db\.transaction/);
  });

  it('never updates or deletes a row in the log, because undo replays it', () => {
    // Rewriting history would make undo produce a document that never existed. Rows go only by
    // cascade when their score does.
    const implementation = codeOf(join(REPO, THE_IMPLEMENTATION));
    expect(implementation).not.toMatch(/UPDATE\s+operations/i);
    expect(implementation).not.toMatch(/DELETE\s+FROM\s+operations/i);
  });

  it('does not migrate an operation payload on the way out (ADR-0028)', () => {
    // Old operation shapes must stay interpretable forever. Migrating one would rewrite history
    // just as surely as an UPDATE would.
    const implementation = codeOf(join(REPO, THE_IMPLEMENTATION));
    const readback = /function toStoredOperation[\s\S]*?\n\}/.exec(implementation)?.[0] ?? '';
    expect(readback).toBeTruthy();
    expect(readback).not.toMatch(/migrate/);
  });
});
