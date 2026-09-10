import { describe, expect, it } from 'vitest';
import { applyOperation, replay } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { OperationError } from '@sibei/api';
import { sectionStartingAt } from '@sibei/model';
import type { Score, Section } from '@sibei/model';

/**
 * The `section.set` / `section.rm` ops through the applier (V7, ADR-0021). A section is *supported
 * and hand-added, never detected*, so the whole of what makes one is this op: pure, no store, and so
 * asserted here, replay included (ADR-0003).
 *
 * A section addresses a whole bar (`bar5`) rather than a beat, because it attaches to the bar it
 * begins on. The load-bearing property the test plan calls out: a rehearsal letter must survive
 * notes being inserted before it — which it does because it keys on a *bar number*, and bar numbers
 * do not move when a bar's contents change.
 */

/** Apply a log against an empty score, keeping the *normalised* ops so replay can be asserted. */
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

const create: Operation = {
  type: 'score.create',
  payload: { id: 'chart', barCount: 8, key: { tonic: 'C', alter: 0, mode: 'major' } },
};

const sectionsOf = (score: Score): Section[] => score.sections;

describe('section.set', () => {
  it('creates a section on a bar, keyed by its number, with the letter it was given', () => {
    const { score } = run([create, { type: 'section.set', target: 'bar5', payload: { letter: 'A' } }]);
    const section = sectionStartingAt(score, 5);
    expect(section).not.toBeNull();
    expect(section!.startBar).toBe(5);
    expect(section!.letter).toBe('A');
    expect(section!.name).toBeNull();
  });

  it('takes a name as well as a letter, and either alone', () => {
    const { score } = run([
      create,
      { type: 'section.set', target: 'bar1', payload: { letter: 'A', name: 'Head' } },
      { type: 'section.set', target: 'bar5', payload: { name: 'Bridge' } },
    ]);
    expect(sectionStartingAt(score, 1)).toMatchObject({ letter: 'A', name: 'Head' });
    expect(sectionStartingAt(score, 5)).toMatchObject({ letter: null, name: 'Bridge' });
  });

  it('is a bare boundary when given no letter or name — a section still forces a line break', () => {
    const { score } = run([create, { type: 'section.set', target: 'bar5', payload: {} }]);
    expect(sectionStartingAt(score, 5)).toMatchObject({ startBar: 5, letter: null, name: null });
  });

  it('upserts: a second set on the same bar keeps the id and updates the letter', () => {
    const first = applyOperation(run([create]).score, {
      type: 'section.set',
      target: 'bar5',
      payload: { letter: 'A' },
    });
    const id = sectionStartingAt(first.score, 5)!.id;
    const second = applyOperation(first.score, { type: 'section.set', target: 'bar5', payload: { letter: 'B' } });
    expect(sectionsOf(second.score)).toHaveLength(1);
    expect(sectionStartingAt(second.score, 5)).toMatchObject({ id, letter: 'B' });
  });

  it('keeps a field left out of an upsert and clears one set to empty', () => {
    const withBoth = run([
      create,
      { type: 'section.set', target: 'bar5', payload: { letter: 'A', name: 'Bridge' } },
    ]).score;
    // Re-set only the letter: the name is untouched.
    const kept = applyOperation(withBoth, { type: 'section.set', target: 'bar5', payload: { letter: 'C' } }).score;
    expect(sectionStartingAt(kept, 5)).toMatchObject({ letter: 'C', name: 'Bridge' });
    // An empty letter clears it back to null (no invisible marker).
    const cleared = applyOperation(kept, { type: 'section.set', target: 'bar5', payload: { letter: '  ' } }).score;
    expect(sectionStartingAt(cleared, 5)!.letter).toBeNull();
  });

  it('keeps sections in start-bar order however they were added', () => {
    const { score } = run([
      create,
      { type: 'section.set', target: 'bar5', payload: { letter: 'B' } },
      { type: 'section.set', target: 'bar1', payload: { letter: 'A' } },
      { type: 'section.set', target: 'bar3', payload: { letter: 'A2' } },
    ]);
    expect(sectionsOf(score).map((s) => s.startBar)).toEqual([1, 3, 5]);
  });

  it('records the id it assigned into the logged op', () => {
    const { log } = run([create, { type: 'section.set', target: 'bar5', payload: { letter: 'A' } }]);
    const logged = log[1] as Extract<Operation, { type: 'section.set' }>;
    expect(logged.payload.id).toBe('section-1');
  });

  it('reports the section in changed[]', () => {
    const applied = applyOperation(run([create]).score, {
      type: 'section.set',
      target: 'bar5',
      payload: { letter: 'A' },
    });
    expect(applied.changed).toEqual(['section-1']);
  });

  it('refuses a bar that does not exist, listing what is there', () => {
    expect(() =>
      applyOperation(run([create]).score, { type: 'section.set', target: 'bar99', payload: { letter: 'A' } }),
    ).toThrow(/no bar 99/);
  });

  it('refuses a position address where a whole bar was wanted', () => {
    expect(() =>
      applyOperation(run([create]).score, {
        type: 'section.set',
        target: 'bar5.beat1',
        payload: { letter: 'A' },
      }),
    ).toThrow(/whole bar/);
  });
});

describe('section.rm', () => {
  it('removes the section beginning on a bar', () => {
    const withSection = run([create, { type: 'section.set', target: 'bar5', payload: { letter: 'A' } }]).score;
    const removed = applyOperation(withSection, { type: 'section.rm', target: 'bar5' }).score;
    expect(sectionStartingAt(removed, 5)).toBeNull();
    expect(removed.sections).toHaveLength(0);
  });

  it('leaves other sections in place', () => {
    const two = run([
      create,
      { type: 'section.set', target: 'bar1', payload: { letter: 'A' } },
      { type: 'section.set', target: 'bar5', payload: { letter: 'B' } },
    ]).score;
    const removed = applyOperation(two, { type: 'section.rm', target: 'bar1' }).score;
    expect(removed.sections.map((s) => s.startBar)).toEqual([5]);
  });

  it('refuses a bar that begins no section', () => {
    const withSection = run([create, { type: 'section.set', target: 'bar5', payload: { letter: 'A' } }]).score;
    let thrown: unknown;
    try {
      applyOperation(withSection, { type: 'section.rm', target: 'bar3' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OperationError);
    expect((thrown as Error).message).toMatch(/begins no section/);
  });
});

describe('a rehearsal letter survives edits (the V7 unit case)', () => {
  it('stays on its bar number after notes are inserted before it', () => {
    // Section A on bar 5, then fill bars 1-4 and bar 5 with notes. The section must not move.
    const ops: Operation[] = [
      create,
      { type: 'section.set', target: 'bar5', payload: { letter: 'A' } },
    ];
    for (const bar of [1, 2, 3, 4, 5]) {
      for (const beat of [1, 2, 3, 4]) {
        ops.push({
          type: 'note.add',
          target: `bar${bar}.beat${beat}`,
          payload: { pitch: 'C4', duration: { value: 4, dots: 0 } },
        });
      }
    }
    const { score } = run(ops);
    const section = sectionStartingAt(score, 5);
    expect(section).not.toBeNull();
    expect(section!.letter).toBe('A');
    expect(section!.startBar).toBe(5);
  });
});

describe('replay from empty reproduces the document exactly (ADR-0003)', () => {
  it('rebuilds a chart with sections set, updated, moved and removed', () => {
    const { score, log } = run([
      create,
      { type: 'section.set', target: 'bar1', payload: { letter: 'A', name: 'Head' } },
      { type: 'section.set', target: 'bar5', payload: { letter: 'B', name: 'Bridge' } },
      { type: 'section.set', target: 'bar1', payload: { letter: 'A1' } }, // upsert
      { type: 'section.rm', target: 'bar5' },
      { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'C4', duration: { value: 4, dots: 0 } } },
    ]);
    const replayed = replay(log);
    expect(replayed).toEqual(score);
  });
});
