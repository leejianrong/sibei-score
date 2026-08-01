import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { everyGlyphChart, longFormChart, nastyChart, untitledChart } from '@sibei/fixtures';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { describe, expect, it } from 'vitest';

/**
 * SVG snapshots, not PDF bytes (Q39): PDF structure moves with library versions in
 * ways that are noise, while the SVG is exactly what layout and draw decided.
 *
 * Snapshots are committed as real `.svg` files rather than inline, so a failing diff
 * can be opened in a browser and looked at. Refresh them with `UPDATE_SNAPSHOTS=1`.
 */

const SNAPSHOT_DIR = resolve(import.meta.dirname, '../snapshots');
const UPDATING = process.env['UPDATE_SNAPSHOTS'] === '1';

function checkSnapshot(name: string, actual: string): void {
  const path = join(SNAPSHOT_DIR, name);
  if (UPDATING) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, actual);
    return;
  }

  let expected: string;
  try {
    expected = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`missing snapshot ${name}. Run with UPDATE_SNAPSHOTS=1 to create it.`);
  }
  expect(actual, `${name} differs from its committed snapshot`).toBe(expected);
}

function snapshotScore(score: Score, stem: string): void {
  const pages = renderScoreToSvg(score);
  for (const page of pages) checkSnapshot(`${stem}.page${page.index + 1}.svg`, page.svg);
}

describe('rendered SVG', () => {
  it('matches the committed snapshot for the nasty chart', () => {
    snapshotScore(nastyChart(), 'nasty-chart');
  });

  it('matches the committed snapshot for the every-glyph chart', () => {
    snapshotScore(everyGlyphChart(), 'every-glyph');
  });

  it('matches the committed snapshots for both pages of the long-form chart', () => {
    // Two files, and the second one is the point: until V3b nothing in the repository
    // recorded what a page with no title block looks like, so nothing could notice one
    // growing a phantom header or dropping its top system off the paper.
    snapshotScore(longFormChart(), 'long-form');
  });

  it('matches the committed snapshot for the untitled chart', () => {
    // The page-1 counterpart of long-form's page 2: a first page with no title block on
    // it, so a header band reappearing above the top system is something a file records
    // rather than something only a person could notice (KAN-525).
    snapshotScore(untitledChart(), 'untitled');
  });

  it('is identical when the same score is rendered twice', () => {
    const first = renderScoreToSvg(nastyChart()).map((page) => page.svg);
    const second = renderScoreToSvg(nastyChart()).map((page) => page.svg);
    expect(second).toEqual(first);
  });
});
