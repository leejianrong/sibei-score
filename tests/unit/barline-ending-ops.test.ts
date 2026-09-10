import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import type { Bar, Score } from '@sibei/model';

/**
 * The `barline.set`, `ending.set` and `ending.rm` ops through the applier (V7, ADR-0021). Barline
 * type and endings are *hand-set, never detected* (D48), so the whole of what makes them is these
 * ops — pure, no store, asserted here, replay included (ADR-0003).
 */

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

const create: Operation = { type: 'score.create', payload: { id: 'chart', barCount: 20 } };
const barAt = (score: Score, number: number): Bar => score.bars.find((b) => b.number === number)!;

describe('barline.set', () => {
  it('sets a closing barline on a bar', () => {
    const { score } = run([create, { type: 'barline.set', target: 'bar11', payload: { end: 'double' } }]);
    expect(barAt(score, 11).endBarline).toBe('double');
  });

  it('sets an opening barline on a bar', () => {
    const { score } = run([create, { type: 'barline.set', target: 'bar12', payload: { start: 'repeat-start' } }]);
    expect(barAt(score, 12).startBarline).toBe('repeat-start');
  });

  it('sets both ends at once, leaving the other bars alone', () => {
    const { score } = run([
      create,
      { type: 'barline.set', target: 'bar12', payload: { start: 'repeat-start', end: 'repeat-end' } },
    ]);
    expect(barAt(score, 12).startBarline).toBe('repeat-start');
    expect(barAt(score, 12).endBarline).toBe('repeat-end');
    expect(barAt(score, 11).endBarline).toBe('single'); // untouched default
  });

  it('leaves the end alone when only the start is set', () => {
    const { score } = run([
      create,
      { type: 'barline.set', target: 'bar5', payload: { end: 'final' } },
      { type: 'barline.set', target: 'bar5', payload: { start: 'repeat-start' } },
    ]);
    expect(barAt(score, 5).endBarline).toBe('final'); // kept from the first set
    expect(barAt(score, 5).startBarline).toBe('repeat-start');
  });

  it('reports the bar in changed[]', () => {
    const applied = applyOperation(run([create]).score, {
      type: 'barline.set',
      target: 'bar11',
      payload: { end: 'double' },
    });
    expect(applied.changed).toEqual([barAt(applied.score, 11).id]);
  });

  it('refuses a set that changes neither end', () => {
    expect(() =>
      applyOperation(run([create]).score, { type: 'barline.set', target: 'bar11', payload: {} }),
    ).toThrow(/changed nothing/);
  });

  it('refuses an unknown barline kind', () => {
    expect(() =>
      applyOperation(run([create]).score, {
        type: 'barline.set',
        target: 'bar11',
        payload: { end: 'wavy' as never },
      }),
    ).toThrow(/closing barline is one of/);
  });

  it('refuses a bar that does not exist', () => {
    expect(() =>
      applyOperation(run([create]).score, { type: 'barline.set', target: 'bar99', payload: { end: 'double' } }),
    ).toThrow(/no bar 99/);
  });
});

describe('ending.set / ending.rm', () => {
  it('sets a one-bar 1st ending', () => {
    const { score } = run([
      create,
      { type: 'ending.set', target: 'bar11', payload: { numbers: [1], role: 'start-stop' } },
    ]);
    expect(barAt(score, 11).ending).toEqual({ numbers: [1], role: 'start-stop' });
  });

  it('sets a multi-bar ending as start / continue / stop across bars', () => {
    const { score } = run([
      create,
      { type: 'ending.set', target: 'bar10', payload: { numbers: [1], role: 'start' } },
      { type: 'ending.set', target: 'bar11', payload: { numbers: [1], role: 'continue' } },
      { type: 'ending.set', target: 'bar12', payload: { numbers: [1], role: 'stop' } },
    ]);
    expect(barAt(score, 10).ending!.role).toBe('start');
    expect(barAt(score, 11).ending!.role).toBe('continue');
    expect(barAt(score, 12).ending!.role).toBe('stop');
  });

  it('normalises the pass numbers: sorted and de-duplicated', () => {
    const { score } = run([
      create,
      { type: 'ending.set', target: 'bar11', payload: { numbers: [2, 1, 1], role: 'start-stop' } },
    ]);
    expect(barAt(score, 11).ending!.numbers).toEqual([1, 2]);
  });

  it('replaces an ending already on a bar', () => {
    const first = run([
      create,
      { type: 'ending.set', target: 'bar11', payload: { numbers: [1], role: 'start-stop' } },
    ]).score;
    const second = applyOperation(first, {
      type: 'ending.set',
      target: 'bar11',
      payload: { numbers: [2], role: 'start-stop' },
    }).score;
    expect(barAt(second, 11).ending).toEqual({ numbers: [2], role: 'start-stop' });
  });

  it('removes an ending', () => {
    const withEnding = run([
      create,
      { type: 'ending.set', target: 'bar11', payload: { numbers: [1], role: 'start-stop' } },
    ]).score;
    const removed = applyOperation(withEnding, { type: 'ending.rm', target: 'bar11' }).score;
    expect(barAt(removed, 11).ending).toBeNull();
  });

  it('refuses an empty or non-positive pass-number list', () => {
    for (const numbers of [[], [0], [1.5], [-1]]) {
      expect(() =>
        applyOperation(run([create]).score, {
          type: 'ending.set',
          target: 'bar11',
          payload: { numbers, role: 'start' },
        }),
      ).toThrow(/one or more pass numbers/);
    }
  });

  it('refuses an unknown role', () => {
    expect(() =>
      applyOperation(run([create]).score, {
        type: 'ending.set',
        target: 'bar11',
        payload: { numbers: [1], role: 'middle' as never },
      }),
    ).toThrow(/ending role is one of/);
  });

  it('refuses removing an ending that is not there', () => {
    let thrown: unknown;
    try {
      applyOperation(run([create]).score, { type: 'ending.rm', target: 'bar11' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OperationError);
    expect((thrown as Error).message).toMatch(/carries no ending/);
  });
});

describe('replay from empty reproduces the document exactly (ADR-0003)', () => {
  it('rebuilds a repeat pair with 1st and 2nd endings', () => {
    const { score, log } = run([
      create,
      // A repeat around bars 12..19, a 1st ending on 18-19 and a 2nd on 20.
      { type: 'barline.set', target: 'bar12', payload: { start: 'repeat-start' } },
      { type: 'barline.set', target: 'bar19', payload: { end: 'repeat-end' } },
      { type: 'ending.set', target: 'bar18', payload: { numbers: [1], role: 'start' } },
      { type: 'ending.set', target: 'bar19', payload: { numbers: [1], role: 'stop' } },
      { type: 'ending.set', target: 'bar20', payload: { numbers: [2], role: 'start-stop' } },
      { type: 'barline.set', target: 'bar20', payload: { end: 'final' } },
      { type: 'ending.rm', target: 'bar20' },
    ]);
    expect(replay(log)).toEqual(score);
  });
});
