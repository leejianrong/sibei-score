import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { isMetricallyValid, tupletOf } from '@sibei/model';
import type { Bar, Score } from '@sibei/model';

/**
 * `tuplet.set` / `tuplet.rm` through the applier (SIB2-166): bracket a run, re-lay it, take it off,
 * and keep the bar metrically valid and the MusicXML round trip intact.
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

const create: Operation = { type: 'score.create', payload: { id: 'chart', barCount: 4 } };
const eighth = { value: 8, dots: 0 } as const;
const quarter = { value: 4, dots: 0 } as const;
const bar3 = (score: Score): Bar => score.bars.find((b) => b.number === 3)!;

/** A quarter, three written eighths (a triplet to be), a quarter and a last quarter that overshoots until the triplet closes. */
const triplet = (): Operation[] => [
  create,
  { type: 'note.add', target: 'bar3.beat1', payload: { pitch: 'C5', duration: quarter } },
  { type: 'note.add', target: 'bar3.beat2', payload: { pitch: 'D5', duration: eighth } },
  { type: 'note.add', target: 'bar3.beat2.5', payload: { pitch: 'E5', duration: eighth } },
  { type: 'note.add', target: 'bar3.beat3', payload: { pitch: 'F5', duration: eighth } },
  { type: 'note.add', target: 'bar3.beat3.5', payload: { pitch: 'G5', duration: quarter } },
  { type: 'note.add', target: 'bar3.beat4.5', payload: { pitch: 'A5', duration: quarter } },
];

const setTriplet: Operation = {
  type: 'tuplet.set',
  target: 'bar3.beat2',
  payload: { actual: 3, normal: 2, count: 3 },
};

describe('tuplet.set', () => {
  it('brackets three items as a triplet and closes the bar up behind it', () => {
    const { score } = run([...triplet(), setTriplet]);
    const bar = bar3(score);
    expect(bar.tuplets).toHaveLength(1);
    expect(bar.tuplets[0]).toMatchObject({ actual: 3, normal: 2 });
    expect(bar.items.map((i) => i.onset)).toEqual([0, 480, 640, 800, 960, 1440]);
    expect(isMetricallyValid(bar, score.meta.time)).toBe(true);
  });

  it("defaults the span to the ratio's note count and records the id", () => {
    const applied = applyOperation(run(triplet()).score, {
      type: 'tuplet.set',
      target: 'bar3.beat2',
      payload: { actual: 3, normal: 2 },
    });
    const payload = (applied.operation as { payload: { count: number; id: string } }).payload;
    expect(payload.count).toBe(3);
    expect(payload.id).toMatch(/^tuplet-/);
  });

  it('replays exactly, and the single log entry is the single undo unit', () => {
    const { score, log } = run([...triplet(), setTriplet]);
    expect(replay(log)).toEqual(score);
    expect(bar3(replay(log.slice(0, -1))!).tuplets).toEqual([]);
  });

  it('refuses nesting, overruns, fractional ticks and a bad ratio', () => {
    const fails = (op: Operation, ops: Operation[] = triplet()): void => {
      expect(() => run([...ops, op])).toThrow(OperationError);
    };
    fails(setTriplet, [...triplet(), setTriplet]);
    fails({ type: 'tuplet.set', target: 'bar3.beat4.5', payload: { actual: 3, normal: 2, count: 3 } });
    fails({ type: 'tuplet.set', target: 'bar3.beat2', payload: { actual: 3, normal: 3 } });
    fails({ type: 'tuplet.set', target: 'bar3.beat2', payload: { actual: 1, normal: 2 } });
    fails({ type: 'tuplet.set', target: 'bar3.beat2', payload: { actual: 7, normal: 4, count: 1 } });
  });

  it('survives a MusicXML round trip as a tuplet of the same ratio and members', () => {
    const { score } = run([...triplet(), setTriplet]);
    const back = musicXmlToScore(scoreToMusicXml(score)).score;
    const bar = back.bars.find((b) => b.items.length === 6)!;
    expect(bar.tuplets).toHaveLength(1);
    expect(bar.tuplets[0]).toMatchObject({ actual: 3, normal: 2 });
    expect(bar.tuplets[0]!.memberIds).toHaveLength(3);
    expect(bar.items.map((i) => i.onset)).toEqual([0, 480, 640, 800, 960, 1440]);
  });
});

describe('tuplet.rm', () => {
  it('takes the bracket off from any member and restores the written lengths', () => {
    const before = run(triplet()).score;
    const { score } = run([...triplet(), setTriplet, { type: 'tuplet.rm', target: 'bar3.beat2' }]);
    expect(bar3(score).tuplets).toEqual([]);
    expect(bar3(score).items.map((i) => i.onset)).toEqual(bar3(before).items.map((i) => i.onset));
    expect(tupletOf(bar3(score).items[1]!.id, bar3(score))).toBeNull();
  });

  it('refuses an item that is not in a tuplet', () => {
    expect(() => run([...triplet(), { type: 'tuplet.rm', target: 'bar3.beat1' }])).toThrow(OperationError);
  });
});
