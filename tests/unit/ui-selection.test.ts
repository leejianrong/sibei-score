import { describe, expect, it } from 'vitest';
import { applyOperation } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { barViews, formatPitch } from '@sibei/model';
import type { Score } from '@sibei/model';
import { countNotes, itemsBetween, itemsInBars, itemsInStaff, selectionOps, shiftPitch } from '../../packages/ui/src/lib/selection.js';

/**
 * Selecting many notes and acting on them (SIB2-278): which ids a gesture means, and that every edit's ops are ones the
 * real applier accepts, in the order given, landing as the music it should.
 */

const q = { value: 4, dots: 0 } as const;
const add = (target: string, pitch: string): Operation => ({ type: 'note.add', target, payload: { pitch, duration: q } }) as Operation;

function build(): Score {
  let score: Score | null = null;
  const ops: Operation[] = [
    { type: 'score.create', payload: { id: 'sel', barCount: 3 } } as Operation,
    add('bar1.beat1', 'C4'),
    add('bar1.beat2', 'D4'),
    add('bar1.beat3', 'E4'),
    add('bar2.beat1', 'F4'),
    add('bar2.beat2', 'G4'),
    add('bar3.beat1', 'A4'),
  ];
  for (const op of ops) score = applyOperation(score, op).score;
  return score!;
}

function ids(score: Score): string[] {
  return barViews(score).flatMap((bar) => bar.items.map((item) => item.id));
}

function pitches(score: Score): string[] {
  return barViews(score).flatMap((bar) => bar.items.map((item) => (item.kind === 'note' ? formatPitch(item.pitch) : 'r')));
}

function applyAll(score: Score, ops: Operation[]): Score {
  return ops.reduce((current, op) => applyOperation(current, op).score, score);
}

describe('which items a gesture selects', () => {
  const score = build();
  const all = ids(score);

  it('selects the range between two clicks, in either order', () => {
    expect(itemsBetween(score, all[1]!, all[4]!)).toEqual(all.slice(1, 5));
    expect(itemsBetween(score, all[4]!, all[1]!)).toEqual(all.slice(1, 5));
  });

  it('selects a bar range and a whole staff', () => {
    expect(itemsInBars(score, 1, 1, 2)).toEqual(all.slice(0, 5));
    expect(itemsInBars(score, 1, 3, 2)).toEqual(all.slice(3));
    expect(itemsInStaff(score, 1)).toEqual(all);
    expect(countNotes(score, all)).toBe(6);
  });
});

describe('editing a selection', () => {
  const score = build();
  const picked = ids(score).slice(0, 5);

  it('moves every note a step or an octave', () => {
    expect(pitches(applyAll(score, selectionOps(score, picked, { type: 'step', steps: 1 })))).toEqual(['D4', 'E4', 'F4', 'G4', 'A4', 'A4']);
    expect(pitches(applyAll(score, selectionOps(score, picked, { type: 'step', steps: -7 })))).toEqual(['C3', 'D3', 'E3', 'F3', 'G3', 'A4']);
    expect(formatPitch(shiftPitch({ step: 'B', alter: -1, octave: 4 }, 1))).toBe('Cb5');
    expect(formatPitch(shiftPitch({ step: 'B', alter: -1, octave: 4 }, 1, () => 0))).toBe('C5');
  });

  it('changes every duration', () => {
    const next = applyAll(score, selectionOps(score, picked, { type: 'duration', duration: { value: 8, dots: 0 } }));
    expect(barViews(next).flatMap((bar) => bar.items.map((item) => item.duration.value))).toEqual([8, 8, 8, 8, 8, 4]);
  });

  it('ties the selection into one chain, and unties it', () => {
    const tied = applyAll(score, selectionOps(score, picked, { type: 'tie', on: true }));
    const roles = barViews(tied).flatMap((bar) => bar.items.map((item) => (item.kind === 'note' ? item.tie : '-')));
    expect(roles).toEqual(['start', 'both', 'both', 'both', 'stop', 'none']);
    const loose = applyAll(tied, selectionOps(tied, picked, { type: 'tie', on: false }));
    expect(barViews(loose).flatMap((bar) => bar.items.map((item) => (item.kind === 'note' ? item.tie : '-')))).toEqual(['none', 'none', 'none', 'none', 'none', 'none']);
  });

  it('sets an articulation on every note and deletes the selection', () => {
    const marked = applyAll(score, selectionOps(score, picked, { type: 'articulation', marks: ['staccato'] }));
    const first = barViews(marked)[0]!.items[0]!;
    expect(first.kind === 'note' && first.articulations).toEqual(['staccato']);
    const gone = applyAll(score, selectionOps(score, picked, { type: 'delete' }));
    expect(pitches(gone)).toEqual(['A4']);
  });

  it('is one batch: every edit is a list of ops a client sends together', () => {
    const ops = selectionOps(score, picked, { type: 'step', steps: 1 });
    expect(ops).toHaveLength(5);
    expect(new Set(ops.map((op) => op.type))).toEqual(new Set(['note.set']));
  });
});
