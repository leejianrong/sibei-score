import { describe, expect, it } from 'vitest';
import {
  OPERATION_VERSION,
  effectiveLog,
  replay,
  replayLog,
  resolveLog,
} from '@sibei/api';
import type { ControlOperation, Operation, StoredOperation } from '@sibei/api';
import { dur, formatPitch, notesOf } from '@sibei/model';

/**
 * Undo and redo as log resolution (V8a, ADR-0003), with no store in sight — the same discipline as
 * `apply.test.ts`. ADR-0003 keeps the log append-only forever, so undo cannot delete the last
 * batch's rows; it appends an `undo` control marker, and `resolveLog`/`replayLog` are what turn a
 * log full of those markers back into the document they describe. Everything undo *means* is decided
 * here, so it is asserted here.
 */

const create: Operation = { type: 'score.create', payload: { id: 'score-1', barCount: 4 } };
const noteAt = (target: string, pitch: string): Operation => ({
  type: 'note.add',
  target,
  payload: { pitch, duration: dur(4) },
});

/** Build a stored log out of batches: each inner array is one undoable unit, in order. */
function log(...batches: (Operation | ControlOperation)[][]): StoredOperation[] {
  const stored: StoredOperation[] = [];
  let seq = 1;
  batches.forEach((ops, index) => {
    for (const operation of ops) {
      stored.push({ seq: seq++, batch: index + 1, version: OPERATION_VERSION, operation, createdAt: '2026-09-10T00:00:00Z' });
    }
  });
  return stored;
}

const undo: ControlOperation = { type: 'undo' };
const redo: ControlOperation = { type: 'redo' };

/** The pitches of a resolved log's document, for a compact assertion on what survived. */
function pitches(stored: StoredOperation[]): string[] {
  const score = replayLog(stored);
  if (score === null) return [];
  return score.bars.flatMap((bar) => notesOf(bar).map((note) => formatPitch(note.pitch)));
}

describe('resolveLog: which content ops a log resolves to', () => {
  it('is every content op when there are no markers', () => {
    const stored = log([create], [noteAt('bar1.beat1', 'C5')], [noteAt('bar1.beat2', 'D5')]);
    expect(effectiveLog(stored)).toEqual([create, noteAt('bar1.beat1', 'C5'), noteAt('bar1.beat2', 'D5')]);
    expect(resolveLog(stored).redo).toEqual([]);
  });

  it('drops the last batch on undo and sets it aside for redo', () => {
    const a = noteAt('bar1.beat1', 'C5');
    const b = noteAt('bar1.beat2', 'D5');
    const stored = log([create], [a], [b], [undo]);
    const state = resolveLog(stored);
    expect(state.applied).toEqual([[create], [a]]);
    expect(state.redo).toEqual([[b]]);
    expect(effectiveLog(stored)).toEqual([create, a]);
  });

  it('brings the set-aside batch back on redo', () => {
    const a = noteAt('bar1.beat1', 'C5');
    const b = noteAt('bar1.beat2', 'D5');
    const stored = log([create], [a], [b], [undo], [redo]);
    expect(effectiveLog(stored)).toEqual([create, a, b]);
    expect(resolveLog(stored).redo).toEqual([]);
  });

  it('undoes a batch of many as one unit, an edit at a time otherwise', () => {
    const four = [
      noteAt('bar1.beat1', 'C5'),
      noteAt('bar1.beat2', 'D5'),
      noteAt('bar1.beat3', 'E5'),
      noteAt('bar1.beat4', 'F5'),
    ];

    // One batch of four, one undo: all four gone.
    expect(pitches(log([create], four, [undo]))).toEqual([]);

    // Four separate batches, one undo: only the last is gone.
    expect(pitches(log([create], [four[0]!], [four[1]!], [four[2]!], [four[3]!], [undo]))).toEqual([
      'C5',
      'D5',
      'E5',
    ]);
  });

  it('discards the redo future once a fresh edit lands after an undo', () => {
    const a = noteAt('bar1.beat1', 'C5');
    const b = noteAt('bar1.beat2', 'D5');
    const c = noteAt('bar1.beat3', 'E5');
    // …create, a, b, undo (b set aside), c. The edit clears the redo stack, so a later redo is inert.
    const stored = log([create], [a], [b], [undo], [c], [redo]);
    expect(resolveLog(stored).redo).toEqual([]);
    expect(pitches(stored)).toEqual(['C5', 'E5']);
  });

  it('is total over a malformed log: a marker with nothing to act on is a no-op', () => {
    // An undo before any content, and a redo with nothing set aside. Neither is a log the applier
    // would ever write, but replay must not throw on one — it stays a faithful function.
    const stored = log([undo], [create], [redo], [noteAt('bar1.beat1', 'C5')]);
    expect(() => resolveLog(stored)).not.toThrow();
    expect(pitches(stored)).toEqual(['C5']);
  });
});

describe('replayLog vs replay', () => {
  it('agrees with replay on a log with no markers, and folds the effective ops with them', () => {
    const a = noteAt('bar1.beat1', 'C5');
    const b = noteAt('bar1.beat2', 'D5');
    const marked = log([create], [a], [b], [undo]);

    // Whole stored log (markers and all) == folding just the content ops that survive.
    expect(replayLog(marked)).toEqual(replay([create, a]));
  });

  it('undo then redo returns the identical document', () => {
    const a = noteAt('bar1.beat1', 'C5');
    const b = noteAt('bar1.beat2', 'D5');
    const before = replayLog(log([create], [a], [b]));
    const roundTrip = replayLog(log([create], [a], [b], [undo], [redo]));
    expect(roundTrip).toEqual(before);
  });
});
