import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { clefChangeChart, fermatasStavesChart, ottavaStavesChart, drumChart, aabaChart, articulationsChart, clefsAndKeysChart, everyGlyphChart, fullBandChart, grandStaffChart, leadBassChart, longFormChart, staffFurnitureChart, twoVoiceChart, voiceCollisionsChart, nastyChart, marksChart, graceNotesChart, reviewChart, slurChart, titleBlockChart, untitledChart } from '@sibei/fixtures';
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

  it('matches the committed snapshot for the grace-notes chart', () => {
    // SIB2-185: slashed and unslashed single graces, accidentals, a beamed group of three, and graces on
    // ledger-line notes, each in the room spacing left before its principal note.
    snapshotScore(graceNotesChart(), 'grace-notes');
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

  // SIB2-228 (ADR-0041, slice 4): the staves-and-voices fixtures, each looked at with `pnpm proof <name>` before its
  // snapshot was written, and the description of what was seen is in the slice's PR.
  it('matches the committed snapshot for the grand staff (a brace, a bass clef, one barline through both staves)', () => {
    snapshotScore(grandStaffChart(), 'grand-staff');
  });

  it('matches the committed snapshot for two voices on one staff (stems apart, rests offset)', () => {
    snapshotScore(twoVoiceChart(), 'two-voice');
  });

  it('matches the committed snapshot for a lead and a bass (a bracket across two parts)', () => {
    snapshotScore(leadBassChart(), 'lead-bass');
  });

  it('matches the committed snapshots for the full band (a bracket, a brace, a one-line percussion staff, three pages)', () => {
    snapshotScore(fullBandChart(), 'full-band');
  });

  // SIB2-230 (ADR-0041, slice 6): a drum kit on five lines, looked at with `pnpm proof drum-kit` before its snapshot.
  it('matches the committed snapshot for a drum kit (x, circled x and diamond heads, a ledger line, hands up and feet down)', () => {
    snapshotScore(drumChart(), 'drum-kit');
  });

  it('matches the committed snapshot for voices meeting (shared unison, seconds, a crossing, a third voice, a triplet and a tie)', () => {
    snapshotScore(voiceCollisionsChart(), 'voice-collisions');
  });

  it('matches the committed snapshot for an ottava line on each staff of a grand staff', () => {
    snapshotScore(ottavaStavesChart(), 'ottava-staves');
  });

  it('matches the committed snapshot for fermatas under a note below the staff and a stem-down voice', () => {
    snapshotScore(fermatasStavesChart(), 'fermatas-staves');
  });

  it('matches the committed snapshot for a clef change at a bar (small clef mid-system, full clef at a system head)', () => {
    snapshotScore(clefChangeChart(), 'clef-change');
  });

  it('matches the committed snapshot for every clef in a flat key', () => {
    snapshotScore(clefsAndKeysChart(), 'clefs-and-keys');
  });

  it('matches the committed snapshot for repeats, marks and rests on a lower staff', () => {
    snapshotScore(staffFurnitureChart(), 'staff-furniture');
  });

  it('is identical when the same score is rendered twice', () => {
    const first = renderScoreToSvg(nastyChart()).map((page) => page.svg);
    const second = renderScoreToSvg(nastyChart()).map((page) => page.svg);
    expect(second).toEqual(first);
  });
});
