import { describe, expect, it } from 'vitest';
import { OPERATION_VERSION, effectiveLog, replayLog, resolveLog } from '@sibei/api';
import type { ControlOperation, Operation, StoredOperation } from '@sibei/api';
import { barViews, dur, formatPitch, notesOf } from '@sibei/model';

/**
 * `group`: a burst of batches as one undoable unit (SIB2-282, the ADR-0003 amendment). Log resolution only, with no store,
 * like `undo-redo.test.ts`: everything grouping means is decided by `resolveLog`, so it is asserted here.
 */

const create: Operation = { type: 'score.create', payload: { id: 'score-1', barCount: 4 } };
const noteAt = (target: string, pitch: string): Operation => ({ type: 'note.add', target, payload: { pitch, duration: dur(4) } });

function log(...batches: (Operation | ControlOperation)[][]): StoredOperation[] {
  const stored: StoredOperation[] = [];
  let seq = 1;
  batches.forEach((ops, index) => {
    for (const operation of ops) {
      stored.push({ seq: seq++, batch: index + 1, version: OPERATION_VERSION, operation, createdAt: '2026-11-24T00:00:00Z' });
    }
  });
  return stored;
}

const undo: ControlOperation = { type: 'undo' };
const redo: ControlOperation = { type: 'redo' };
const group = (count: number): ControlOperation => ({ type: 'group', count });

function pitches(stored: StoredOperation[]): string[] {
  const score = replayLog(stored);
  if (score === null) return [];
  return barViews(score).flatMap((bar) => notesOf(bar).map((note) => formatPitch(note.pitch)));
}

const c = noteAt('bar1.beat1', 'C5');
const d = noteAt('bar1.beat2', 'D5');
const e = noteAt('bar1.beat3', 'E5');
const f = noteAt('bar1.beat4', 'F5');

describe('group: a burst of batches as one undoable unit (SIB2-282)', () => {
  it('folds the last n batches into one applied entry, changing no document', () => {
    const plain = log([create], [c], [d], [e]);
    const grouped = log([create], [c], [d], [e], [group(3)]);
    expect(resolveLog(grouped).applied).toEqual([[create], [c, d, e]]);
    expect(pitches(grouped)).toEqual(pitches(plain));
    expect(effectiveLog(grouped)).toEqual(effectiveLog(plain));
  });

  it('is undone whole by one undo, and brought back whole by one redo', () => {
    const undone = log([create], [c], [d], [e], [group(3)], [undo]);
    expect(pitches(undone)).toEqual([]);
    expect(resolveLog(undone).redo).toEqual([[c, d, e]]);
    expect(pitches(log([create], [c], [d], [e], [group(3)], [undo], [redo]))).toEqual(['C5', 'D5', 'E5']);
  });

  it('leaves what came before the burst as its own unit', () => {
    expect(pitches(log([create], [c], [d], [e], [f], [group(3)], [undo]))).toEqual(['C5']);
  });

  it('never folds the score.create batch, and tolerates a count the log cannot honour', () => {
    const stored = log([create], [c], [d], [group(5)]);
    expect(resolveLog(stored).applied).toEqual([[create], [c, d]]);
    expect(pitches(stored)).toEqual(['C5', 'D5']);
  });

  it('keeps an agent batch one unit: grouping merges whole batches only', () => {
    expect(pitches(log([create], [c, d], [e], [group(2)], [undo]))).toEqual([]);
    expect(resolveLog(log([create], [c, d], [e])).applied).toEqual([[create], [c, d], [e]]);
  });

  it('replays from empty with markers in the middle', () => {
    expect(pitches(log([create], [c], [d], [group(2)], [e], [undo], [undo], [redo]))).toEqual(['C5', 'D5']);
  });

  it('is a no-op on a log that never groups: old logs resolve exactly as before', () => {
    const old = log([create], [c], [d], [undo], [redo], [e]);
    expect(resolveLog(old).applied).toEqual([[create], [c], [d], [e]]);
  });
});
