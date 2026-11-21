import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import type { Score } from '@sibei/model';

/** `bar.add` and `bar.rm` through the applier (SIB2-186): renumbering, sections, replay. */

function run(operations: Operation[]): { score: Score; log: Operation[] } {
  const log: Operation[] = [];
  let score: Score | null = null;
  for (const operation of operations) {
    const applied = applyOperation(score, operation);
    score = applied.score;
    log.push(applied.operation);
  }
  if (score === null) throw new Error('no score');
  return { score, log };
}

const create: Operation = { type: 'score.create', payload: { id: 'chart', barCount: 8 } };
const numbers = (score: Score): number[] => score.bars.map((b) => b.number);

describe('bar.add', () => {
  it('appends with no target', () => {
    const { score } = run([create, { type: 'bar.add' }]);
    expect(numbers(score)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(score.bars[8]!.id).toBe('bar-9');
  });

  it('inserts after a bar, renumbering later bars and moving a later section, ids staying put', () => {
    const { score } = run([
      create,
      { type: 'section.set', target: 'bar5', payload: { letter: 'B' } },
      { type: 'note.add', target: 'bar6.beat1', payload: { pitch: 'C5', duration: { value: 4, dots: 0 } } },
      { type: 'bar.add', target: 'bar4', payload: { count: 2 } },
    ]);
    expect(numbers(score)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(score.sections[0]!.startBar).toBe(7);
    // The old bar 6 (id bar-6) is now bar 8 and still holds its note.
    const moved = score.bars.find((b) => b.id === 'bar-6')!;
    expect(moved.number).toBe(8);
    expect(moved.items).toHaveLength(1);
    expect(score.bars.find((b) => b.number === 5)!.items).toHaveLength(0);
  });

  it('replays from its recorded ids', () => {
    const { score, log } = run([create, { type: 'bar.add', target: 'bar2', payload: { count: 2 } }]);
    expect(replay(log)).toEqual(score);
  });
});

describe('bar.rm', () => {
  it('removes an empty bar and renumbers the rest', () => {
    const { score } = run([
      create,
      { type: 'section.set', target: 'bar6', payload: { letter: 'B' } },
      { type: 'bar.rm', target: 'bar3' },
    ]);
    expect(numbers(score)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(score.sections[0]!.startBar).toBe(5);
  });

  it('refuses a bar that holds a note, or starts a section', () => {
    const note: Operation = {
      type: 'note.add',
      target: 'bar2.beat1',
      payload: { pitch: 'C5', duration: { value: 4, dots: 0 } },
    };
    expect(() => run([create, note, { type: 'bar.rm', target: 'bar2' }])).toThrow(OperationError);
    expect(() =>
      run([create, { type: 'section.set', target: 'bar2', payload: {} }, { type: 'bar.rm', target: 'bar2' }]),
    ).toThrow(/section start/);
  });
});
