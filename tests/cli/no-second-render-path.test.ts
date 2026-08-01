import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The CLI asks the API for a PDF. It does not make one.
 *
 * V3d gives the CLI a verb that produces a printable page, and the obvious way to write it was to
 * call `renderScoreToPdf` on a document fetched with `sbscore open`. That would have worked, and it
 * would have quietly created the thing ADR-0002 exists to prevent: a second implementation of what
 * a chart looks like, in the client, free to drift from the one the browser will use. The same
 * argument as the single write path, one seam over — "the UI and the CLI cannot disagree" is worth
 * having only while it is structural.
 *
 * So this is the render-side sibling of `tests/arch/one-writer.test.ts`. It lives here rather than
 * in `tests/arch` because it is about `packages/cli` specifically and because V3d owns both; if a
 * second surface ever needs the same rule, it belongs upstairs.
 */

const REPO = resolve(import.meta.dirname, '../..');
const CLI = join(REPO, 'packages/cli');

/** What a renderer is made of. Naming any of these in the CLI means it is rendering. */
const THE_RENDER_PATH = ['@sibei/pdf', '@sibei/layout', '@sibei/engrave'];

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules') continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (entry.endsWith('.ts')) found.push(path);
  }
  return found;
}

/**
 * Code with the comments taken out. Explaining *why* the CLI must not render, and naming the
 * packages it must not reach for, is not a dependency on them — the allowance the store and blob
 * seam tests make for the same reason.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('there is no second render path (ADR-0002, ADR-0014)', () => {
  it('has cli source to check', () => {
    // Guards the guard: an empty file list would make every assertion below a tautology.
    expect(sourceFiles(join(CLI, 'src')).length).toBeGreaterThan(0);
  });

  it('does not depend on the renderer', () => {
    const manifest = readFileSync(join(CLI, 'package.json'), 'utf8');
    for (const dependency of THE_RENDER_PATH) {
      expect(manifest).not.toContain(dependency);
    }
  });

  it('does not import the renderer anywhere in its source', () => {
    const offenders = sourceFiles(join(CLI, 'src'))
      .filter((file) => THE_RENDER_PATH.some((name) => codeOf(file).includes(name)))
      .map((file) => relative(REPO, file));
    expect(offenders).toEqual([]);
  });

  it('does not call a render function by any other route', () => {
    // The import is the obvious leak. A dynamic import, or a re-export through `@sibei/api`, which
    // does hold the render path and is a dependency, is the subtle one.
    const reach = /\b(renderScoreToPdf|renderScoreToSvg|layoutScore|createExporter|MusicFont)\b/;
    const offenders = sourceFiles(join(CLI, 'src'))
      .filter((file) => reach.test(codeOf(file)))
      .map((file) => relative(REPO, file));
    expect(offenders).toEqual([]);
  });
});
