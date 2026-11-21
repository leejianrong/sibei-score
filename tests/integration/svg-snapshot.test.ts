import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { aabaChart, articulationsChart, everyGlyphChart, longFormChart, nastyChart, marksChart, reviewChart, slurChart, titleBlockChart, untitledChart } from '@sibei/fixtures';
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

  it('matches the committed snapshot for the AABA chart', () => {
    // The V7 structure demo: a pickup, four rehearsal-lettered sections, a repeat around the
    // first A with 1st/2nd endings, a double bar and a final bar. This is where the barline and
    // ending glyphs are recorded under real user-set structure, so a change to any of them shows.
    snapshotScore(aabaChart(), 'aaba-chart');
  });

  it('matches the committed snapshot for the slur chart', () => {
    // SIB2-168: the fixture of record for slurs — above and below by stem direction, across a
    // barline, a half-slur pair across the system break, over a leap and a tie, and a chosen side.
    snapshotScore(slurChart(), 'slurs');
  });

  it('matches the committed snapshot for the marks chart', () => {
    // SIB2-183: fermatas over a low note, a high one, a rest and a whole note, with the chord band
    // lifted to clear them. Articulations (SIB2-179) join this fixture.
    snapshotScore(marksChart(), 'marks');
  });

  it('matches the committed snapshot for the title-block chart', () => {
    // SIB2-180: a subtitle under the title, two composer lines and an arranger stacked down the right.
    snapshotScore(titleBlockChart(), 'title-block');
  });

  it('matches the committed snapshot for the articulations chart', () => {
    // SIB2-179: staccato, accent and marcato above and below by stem, stacked, on beamed notes and
    // off the staff, with a fermata over a marked note's neighbour.
    snapshotScore(articulationsChart(), 'articulations');
  });

  it('matches the committed snapshot for the untitled chart', () => {
    // The page-1 counterpart of long-form's page 2: a first page with no title block on
    // it, so a header band reappearing above the top system is something a file records
    // rather than something only a person could notice (KAN-525).
    snapshotScore(untitledChart(), 'untitled');
  });

  it('matches the committed snapshot for the review-shading chart', () => {
    // V14c: the fixture of record for both review washes. Bar 1 shows the flagged-object
    // stripe alone, bar 2 the invalid-bar wash with a flagged note over it, bar 3 a flagged
    // annotation. Nothing else in the corpus draws either treatment, so this file is where a
    // change to the shading geometry or colour shows up as something to look at (ADR-0019).
    snapshotScore(reviewChart(), 'review');
  });

  it('is identical when the same score is rendered twice', () => {
    const first = renderScoreToSvg(nastyChart()).map((page) => page.svg);
    const second = renderScoreToSvg(nastyChart()).map((page) => page.svg);
    expect(second).toEqual(first);
  });
});
