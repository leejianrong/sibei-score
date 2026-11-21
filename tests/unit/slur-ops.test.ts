import { describe, expect, it } from 'vitest';
import { applyOperation, replay, replayLog, OPERATION_VERSION, OperationError } from '@sibei/api';
import type { ControlOperation, Operation, StoredOperation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';

/** `slur.set` / `slur.rm` (SIB2-167): a slur is a `Spanner`, two note ids and a kind. */

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

const create: Operation = { type: 'score.create', payload: { id: 'chart', title: 'T', barCount: 3 } };
const note = (target: string, pitch: string): Operation => ({
  type: 'note.add',
  target,
  payload: { pitch, duration: { value: 4, dots: 0 } },
});
const melody: Operation[] = [
  create,
  note('bar1.beat1', 'C5'),
  note('bar1.beat2', 'D5'),
  note('bar1.beat3', 'E5'),
  note('bar2.beat1', 'F5'),
  note('bar2.beat2', 'G5'),
];
const slur = (target: string, to: string, placement?: 'above' | 'below' | 'auto'): Operation => ({
  type: 'slur.set',
  target,
  payload: placement === undefined ? { to } : { to, placement },
});

describe('slur.set', () => {
  it('stores a slur between two notes, across a barline', () => {
    const { score, log } = run([...melody, slur('bar1.n2', 'bar2.n1')]);
    expect(score.spanners).toEqual([{ id: 'slur-1', kind: 'slur', startId: 'note-2', endId: 'note-4' }]);
    expect(replay(log)).toEqual(score);
  });

  it('an old score has no spanners at all, and keeps none until one is set', () => {
    expect(run(melody).score.spanners).toBeUndefined();
  });

  it('setting the same pair again changes only the placement and keeps the id', () => {
    const first = run([...melody, slur('bar1.n1', 'bar1.n3')]);
    const again = run([...first.log, slur('bar1.n1', 'bar1.n3', 'below')]);
    expect(again.score.spanners).toEqual([
      { id: 'slur-1', kind: 'slur', startId: 'note-1', endId: 'note-3', placement: 'below' },
    ]);
    const cleared = run([...again.log, slur('bar1.n1', 'bar1.n3', 'auto')]);
    expect(cleared.score.spanners?.[0]?.placement).toBeUndefined();
  });

  it('refuses a backwards or single-note slur, a rest, and a bad placement', () => {
    const base = run(melody).score;
    expect(() => applyOperation(base, slur('bar2.n1', 'bar1.n1'))).toThrow(/later one/);
    expect(() => applyOperation(base, slur('bar1.n1', 'bar1.n1'))).toThrow(/later one/);
    expect(() => applyOperation(base, slur('bar1.n1', 'bar1.n9'))).toThrow(OperationError);
    expect(() => applyOperation(base, slur('bar1.n1', 'bar1.n2', 'sideways' as 'above'))).toThrow(/placement/);
    const withRest = run([
      ...melody,
      { type: 'rest.add', target: 'bar3.beat1', payload: { duration: { value: 4, dots: 0 } } },
    ]);
    expect(() => applyOperation(withRest.score, slur('bar2.n2', 'bar3.n1'))).toThrow(OperationError);
  });
});

describe('slur.rm', () => {
  const withSlur = run([...melody, slur('bar1.n1', 'bar1.n3'), slur('bar1.n2', 'bar2.n2')]);

  it('removes by id or by the note it starts on, and the last one clears the lane', () => {
    const byId = run([...withSlur.log, { type: 'slur.rm', target: 'slur-1' }]);
    expect(byId.score.spanners).toHaveLength(1);
    const byNote = run([...byId.log, { type: 'slur.rm', target: 'bar1.n2' }]);
    expect(byNote.score.spanners).toBeUndefined();
  });

  it('says so when nothing is there', () => {
    expect(() => applyOperation(withSlur.score, { type: 'slur.rm', target: 'slur-9' })).toThrow(/no slur/);
  });

  it('removing either end note takes its slur with it', () => {
    const gone = run([...withSlur.log, { type: 'note.rm', target: 'bar1.n3' }]);
    expect(gone.score.spanners?.map((s) => s.id)).toEqual(['slur-2']);
  });
});

describe('undo and the text projection', () => {
  it('undo removes the slur by replay, redo brings it back', () => {
    const { log } = run([...melody, slur('bar1.n1', 'bar1.n3')]);
    const stored = (batches: (Operation | ControlOperation)[][]): StoredOperation[] =>
      batches.flatMap((batch, index) =>
        batch.map((operation, at) => ({
          seq: index * 10 + at + 1,
          batch: index + 1,
          version: OPERATION_VERSION,
          operation,
          createdAt: '2026-11-22T00:00:00Z',
        })),
      );
    const head = log.slice(0, -1).map((op) => [op]);
    const last = log.slice(-1);
    expect(replayLog(stored([...head, last]))?.spanners).toHaveLength(1);
    expect(replayLog(stored([...head, last, [{ type: 'undo' }]]))?.spanners).toBeUndefined();
    expect(replayLog(stored([...head, last, [{ type: 'undo' }], [{ type: 'redo' }]]))?.spanners).toHaveLength(1);
  });

  it('show prints the slur with the addresses slur set takes', () => {
    const { score } = run([...melody, slur('bar1.n2', 'bar2.n1', 'below')]);
    expect(projectScore(score)).toContain('slur  bar1.n2 -> bar2.n1 below slur-1');
  });
});

describe('MusicXML', () => {
  it('round-trips slurs, overlapping ones and placement included', () => {
    const { score } = run([
      ...melody,
      slur('bar1.n1', 'bar2.n1', 'above'),
      slur('bar1.n2', 'bar1.n3'),
      slur('bar2.n1', 'bar2.n2'),
    ]);
    const xml = scoreToMusicXml(score);
    expect(xml).toContain('<slur type="start" number="1" placement="above"');
    expect(xml).toContain('<slur type="start" number="2"');
    const back = musicXmlToScore(xml, { id: 'chart' });
    expect(back.warnings).toEqual([]);
    const where = (s: Score, id: string): string => {
      for (const bar of s.bars) {
        const at = bar.items.findIndex((item) => item.id === id);
        if (at >= 0) return `bar${bar.number}.n${at + 1}`;
      }
      return id;
    };
    const pairs = (s: Score): string[] =>
      (s.spanners ?? [])
        .map((sp) => `${where(s, sp.startId)}>${where(s, sp.endId)}:${sp.placement ?? '-'}`)
        .sort();
    expect(pairs(back.score)).toHaveLength(3);
    expect(pairs(back.score)).toEqual(pairs(score));
  });
});
