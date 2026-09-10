import { describe, expect, it } from 'vitest';
import { structureOps } from '@sibei/ui';
import type { BarStructure, StructureEdits } from '@sibei/ui';

/**
 * The Structure panel's Save diff (V7c). Selecting a bar and pressing Save must post exactly the ops
 * for what changed — no more, no fewer — so the batch is minimal and a no-op save posts nothing (the
 * server refuses an empty batch). This is the one non-visual piece of that card, tested here in the
 * fast layer rather than only through a browser.
 */

const base: BarStructure = {
  barNumber: 7,
  addr: 'bar7',
  isPickup: false,
  hasSection: false,
  letter: '',
  name: '',
  startBarline: 'none',
  endBarline: 'single',
  ending: null,
};

const edits = (over: Partial<StructureEdits> = {}): StructureEdits => ({
  letter: base.letter,
  name: base.name,
  startBarline: base.startBarline,
  endBarline: base.endBarline,
  ending: base.ending,
  ...over,
});

describe('structureOps', () => {
  it('posts nothing when nothing changed', () => {
    expect(structureOps(base, edits())).toEqual([]);
  });

  it('starts a section when a letter is typed onto a bare bar', () => {
    expect(structureOps(base, edits({ letter: 'A' }))).toEqual([
      { type: 'section.set', target: 'bar7', payload: { letter: 'A', name: null } },
    ]);
  });

  it('sets a name with a null letter when only the name is given', () => {
    expect(structureOps(base, edits({ name: 'Bridge' }))).toEqual([
      { type: 'section.set', target: 'bar7', payload: { letter: null, name: 'Bridge' } },
    ]);
  });

  it('removes the section when both fields are cleared on a bar that had one', () => {
    const withSection: BarStructure = { ...base, hasSection: true, letter: 'A', name: 'Head' };
    expect(structureOps(withSection, edits({ letter: '', name: '' }))).toEqual([
      { type: 'section.rm', target: 'bar7' },
    ]);
  });

  it('does not touch the section when the letter is unchanged', () => {
    const withSection: BarStructure = { ...base, hasSection: true, letter: 'A', name: '' };
    expect(structureOps(withSection, edits({ letter: 'A' }))).toEqual([]);
  });

  it('sets only the barline end that changed', () => {
    expect(structureOps(base, edits({ endBarline: 'double' }))).toEqual([
      { type: 'barline.set', target: 'bar7', payload: { end: 'double' } },
    ]);
  });

  it('sets both barline ends in one op when both changed', () => {
    expect(structureOps(base, edits({ startBarline: 'repeat-start', endBarline: 'repeat-end' }))).toEqual([
      { type: 'barline.set', target: 'bar7', payload: { start: 'repeat-start', end: 'repeat-end' } },
    ]);
  });

  it('sets a 1st ending', () => {
    expect(structureOps(base, edits({ ending: { numbers: [1], role: 'start-stop' } }))).toEqual([
      { type: 'ending.set', target: 'bar7', payload: { numbers: [1], role: 'start-stop' } },
    ]);
  });

  it('removes an ending that was cleared', () => {
    const withEnding: BarStructure = { ...base, ending: { numbers: [1], role: 'start-stop' } };
    expect(structureOps(withEnding, edits({ ending: null }))).toEqual([
      { type: 'ending.rm', target: 'bar7' },
    ]);
  });

  it('leaves an unchanged ending alone', () => {
    const withEnding: BarStructure = { ...base, ending: { numbers: [1, 2], role: 'start' } };
    expect(structureOps(withEnding, edits({ ending: { numbers: [1, 2], role: 'start' } }))).toEqual([]);
  });

  it('batches a whole repeat-with-ending in one call, in section/barline/ending order', () => {
    const ops = structureOps(
      base,
      edits({ letter: 'A', startBarline: 'repeat-start', endBarline: 'repeat-end', ending: { numbers: [1], role: 'start-stop' } }),
    );
    expect(ops.map((op) => op.type)).toEqual(['section.set', 'barline.set', 'ending.set']);
  });
});
