import { describe, expect, it } from 'vitest';
import { applyOperation, replay, replayLog, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { allBarViews, chordTones, formatPitch } from '@sibei/model';
import type { Score } from '@sibei/model';

/** Moving notes between hands (SIB2-244): note.move and hand.move, as a re-home of the same onset and duration. */

function run(operations: Operation[]): { score: Score; log: Operation[] } {
  const log: Operation[] = [];
  let score: Score | null = null;
  for (const operation of operations) {
    const applied = applyOperation(score, operation);
    score = applied.score;
    log.push(applied.operation);
  }
  return { score: score!, log };
}

const q = { value: 4, dots: 0 } as const;
const w = { value: 1, dots: 0 } as const;
const setup: Operation[] = [
  { type: 'score.create', payload: { id: 'p', barCount: 3 } },
  { type: 'staff.add', payload: { clef: 'bass' } },
  { type: 'note.add', target: 's1.bar1.beat1', payload: { pitch: 'C5', duration: q } },
  { type: 'note.add', target: 's1.bar1.beat2', payload: { pitch: 'E4', duration: q } },
  { type: 'note.add', target: 's1.bar1.beat2', payload: { pitch: 'C3', duration: q } },
  { type: 'rest.add', target: 's1.bar1.beat3', payload: { duration: { value: 2, dots: 0 } } },
  { type: 'rest.add', target: 's2.bar1.beat1', payload: { duration: w } },
  { type: 'note.add', target: 's1.bar2.beat1', payload: { pitch: 'D3', duration: q } },
  { type: 'rest.add', target: 's1.bar2.beat2', payload: { duration: { value: 2, dots: 1 } } },
  { type: 'rest.add', target: 's2.bar2.beat1', payload: { duration: w } },
];

const items = (score: Score, staff: number, bar: number): string[] => {
  const view = allBarViews(score)[staff - 1]!.views[bar - 1]!;
  return view.items.map((item) =>
    item.kind === 'rest'
      ? `r${item.onset}/${item.duration.value}${'.'.repeat(item.duration.dots)}`
      : `[${chordTones(item).map((t) => formatPitch(t.pitch)).join(' ')}]${item.onset}`,
  );
};

describe('note.move', () => {
  it('moves a note to the other staff, filling the source with a rest and keeping the id', () => {
    const { score, log } = run([...setup, { type: 'note.move', target: 's1.bar2.n1', payload: { to: 's2' } }]);
    expect(items(score, 1, 2)).toEqual(['r0/4', 'r480/2.']);
    expect(items(score, 2, 2)).toEqual(['[D3]0', 'r480/4.', 'r1200/8.', 'r1560/16', 'r1680/8']);
    const moved = allBarViews(score)[1]!.views[1]!.items.find((i) => i.kind === 'note');
    expect(moved?.id).toBe('note-4');
    expect(replay(log)).toEqual(score);
  });

  it('splits the whole rest it lands on, and a pitch of a chord goes alone', () => {
    const { score, log } = run([...setup, { type: 'note.move', target: 's1.bar1.n2.C3', payload: { to: 's2' } }]);
    expect(items(score, 1, 1)).toEqual(['[C5]0', '[E4]480', 'r960/2']);
    expect(items(score, 2, 1)).toEqual(['r0/4', '[C3]480', 'r960/2']);
    expect(replay(log)).toEqual(score);
  });

  it('is one undoable unit: the log without it replays to the original', () => {
    const before = run(setup).score;
    const { score, log } = run([...setup, { type: 'note.move', target: 's1.bar2.n1', payload: { to: 's2' } }]);
    const stored = log.map((operation, index) => ({ seq: index + 1, batch: index + 1, version: 1, operation, createdAt: '' }));
    stored.push({ seq: stored.length + 1, batch: stored.length + 1, version: 1, operation: { type: 'undo' } as never, createdAt: '' });
    expect(replayLog(stored)).toEqual(before);
    expect(score).not.toEqual(before);
  });

  it('refuses a target that holds a different note, never overwriting it', () => {
    const operations: Operation[] = [
      ...setup.slice(0, 6),
      { type: 'note.add', target: 's2.bar1.beat2', payload: { pitch: 'F2', duration: { value: 2, dots: 0 } } },
      { type: 'note.move', target: 's1.bar1.n2.E4', payload: { to: 's2' } },
    ];
    expect(() => run(operations)).toThrow(OperationError);
  });

  it('joins the chord a same-length note on the target already is', () => {
    const { score } = run([
      ...setup.slice(0, 6),
      { type: 'note.add', target: 's2.bar1.beat2', payload: { pitch: 'C3', duration: q } },
      { type: 'note.move', target: 's1.bar1.n2.E4', payload: { to: 's2' } },
    ]);
    expect(items(score, 2, 1)).toEqual(['[C3 E4]480']);
  });

  it('refuses a move to the staff it is on and a voice that does not exist', () => {
    expect(() => run([...setup, { type: 'note.move', target: 's1.bar2.n1', payload: { to: 's1' } }])).toThrow(/already on/);
    expect(() => run([...setup, { type: 'note.move', target: 's1.bar2.n1', payload: { to: 's2.v3' } }])).toThrow(/no voice 3/);
  });
});

describe('hand.move', () => {
  it('moves a bar range below a pitch, splitting the chord at it, and replays', () => {
    const { score, log } = run([...setup, { type: 'hand.move', payload: { from: 's1', to: 's2', first: 1, last: 2, below: 'C4' } }]);
    expect(items(score, 1, 1)).toEqual(['[C5]0', '[E4]480', 'r960/2']);
    expect(items(score, 2, 1)).toEqual(['r0/4', '[C3]480', 'r960/2']);
    expect(items(score, 1, 2)).toEqual(['r0/4', 'r480/2.']);
    expect(items(score, 2, 2)).toEqual(['[D3]0', 'r480/4.', 'r1200/8.', 'r1560/16', 'r1680/8']);
    expect(replay(log)).toEqual(score);
  });

  it('with no pitch limit moves every note of the range', () => {
    const { score } = run([...setup, { type: 'hand.move', payload: { from: 's1', to: 's2', first: 1, last: 1 } }]);
    expect(items(score, 1, 1)).toEqual(['r0/4', 'r480/4', 'r960/2']);
    expect(items(score, 2, 1)).toEqual(['[C5]0', '[C3 E4]480', 'r960/8', 'r1200/8.', 'r1560/16', 'r1680/8']);
  });

  it('says so when nothing matches', () => {
    expect(() => run([...setup, { type: 'hand.move', payload: { from: 's1', to: 's2', first: 1, last: 1, below: 'C2' } }])).toThrow(/nothing moved/);
  });
});
