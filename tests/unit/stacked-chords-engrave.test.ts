import { describe, expect, it } from 'vitest';
import { stackedChordsChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import type { NoteItem } from '@sibei/layout';
import { accidentalColumns, displacedHeads } from '../../packages/engrave/src/chords.js';

/** The chord geometry (SIB2-243): which head crosses the stem, how accidentals stack, and what layout hands the engraver. */

describe('displacedHeads', () => {
  it('moves the second met walking from the stem end, and lets the next head take the stem side again', () => {
    // Positions are half spaces below the top line: a larger number is lower. Up stem walks from the lowest head.
    expect(displacedHeads([8, 7, 5], 'up')).toEqual([false, true, false]);
    // A cluster of four alternates sides.
    expect(displacedHeads([6, 5, 4, 3], 'up')).toEqual([false, true, false, true]);
    // A down stem walks from the highest head.
    expect(displacedHeads([4, 3], 'down')).toEqual([true, false]);
    // A third is not a second.
    expect(displacedHeads([8, 6, 4], 'up')).toEqual([false, false, false]);
    // A unison with another accidental cannot share a head.
    expect(displacedHeads([5, 5], 'up')).toEqual([false, true]);
  });
});

describe('accidentalColumns', () => {
  const head = (position: number, alter: -1 | 1 | null) => ({ position, alter, display: 'auto' as const });

  it('puts an accidental a seventh or more clear in the same column and a closer one in the next', () => {
    expect(accidentalColumns([head(2, 1), head(8, 1)])).toEqual([0, 0]);
    expect(accidentalColumns([head(2, 1), head(4, 1), head(6, 1)])).toEqual([0, 1, 2]);
  });

  it('leaves a head with no accidental in no column', () => {
    expect(accidentalColumns([head(2, 1), head(4, null)])).toEqual([0, null]);
  });
});

describe('layout of a stacked chord', () => {
  it('carries the extra pitches as tones on the one note item, with their own ties', () => {
    const result = layout(stackedChordsChart());
    const items = result.pages.flatMap((page) => page.systems.flatMap((system) => system.bars.flatMap((bar) => bar.items)));
    const notes = items.filter((item): item is NoteItem => item.kind === 'note');
    const triad = notes.find((note) => note.tones !== undefined && note.tones.length === 2);
    expect(triad).toBeDefined();
    const ties = result.pages.flatMap((page) => page.systems.flatMap((system) => system.ties));
    // Bar 6's C4 and G4 are tied into bar 7: two ties, each between pitch ids.
    expect(ties.filter((tie) => tie.fromNoteId !== null && tie.toNoteId !== null)).toHaveLength(2);
  });
});
