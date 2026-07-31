import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../../vitest.config.js';

/**
 * The suite is two layers from V2 on (`vitest.config.ts`), and the failure mode of a
 * layered suite is a test directory that belongs to neither: `pnpm test` reports green,
 * nothing in that directory has run, and there is no red anywhere to notice.
 *
 * So the layers are asserted to cover the tree. This is the guard on the split itself.
 */

const REPO = resolve(import.meta.dirname, '../..');

/** Every directory under `tests/` that holds tests, plus `snapshots`, which holds fixtures. */
function testDirectories(): string[] {
  return readdirSync(join(REPO, 'tests')).filter((entry) =>
    statSync(join(REPO, 'tests', entry)).isDirectory(),
  );
}

/**
 * The include globs of every configured project, read out of the config itself rather than
 * restated here — restating them is how a guard ends up guarding the wrong thing.
 */
function configuredProjects(): { name: string; include: string[] }[] {
  const config = vitestConfig as {
    test?: { projects?: { test?: { name?: string; include?: string[] } }[] };
  };
  return (config.test?.projects ?? []).map((project) => ({
    name: project.test?.name ?? '(unnamed)',
    include: project.test?.include ?? [],
  }));
}

/** The `tests/<directory>` each glob reaches into. */
function directoriesOf(project: { include: string[] }): string[] {
  return project.include.map((glob) => glob.split('/')[1] ?? '');
}

describe('the suite layers', () => {
  it('are the two the config declares', () => {
    expect(configuredProjects().map((project) => project.name)).toEqual(['fast', 'infra']);
  });

  it('cover every test directory, so none can go silently unrun', () => {
    const covered = new Set(configuredProjects().flatMap(directoriesOf));
    // `snapshots` holds committed .svg files, not tests, and is deliberately not a layer.
    const uncovered = testDirectories().filter(
      (directory) => directory !== 'snapshots' && !covered.has(directory),
    );
    expect(uncovered).toEqual([]);
  });

  it('claim no directory that is not there', () => {
    const present = new Set(testDirectories());
    const claimed = configuredProjects().flatMap(directoriesOf);
    expect(claimed.filter((directory) => !present.has(directory))).toEqual([]);
  });

  it('do not overlap, so nothing runs twice under two names', () => {
    const seen = new Map<string, string>();
    for (const project of configuredProjects()) {
      for (const directory of directoriesOf(project)) {
        expect(seen.get(directory)).toBeUndefined();
        seen.set(directory, project.name);
      }
    }
  });

  it('keep the store out of the fast layer, which is what the pre-push hook runs', () => {
    // The split has one job: the gate stays runnable with nothing installed. If a directory
    // needing the native binding ever lands in `fast`, the hook gets slower and more fragile
    // and the reason for the split is gone.
    const fast = configuredProjects().find((project) => project.name === 'fast');
    expect(directoriesOf(fast!)).not.toContain('store');
  });
});
