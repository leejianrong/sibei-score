import { describe, expect, it } from 'vitest';
import { OperationError, applyOperation, replay } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { TICKS_PER_QUARTER, barMetrics, dur, formatPitch, notesOf } from '@sibei/model';
import type { Score } from '@sibei/model';

/**
 * The applier as a pure function (ADR-0003). No store anywhere in this file, which is the point:
 * everything interesting about applying an operation is decided here, so it can be asserted here.
 */

const Q = TICKS_PER_QUARTER;

function create(overrides: Partial<Parameters<typeof scoreCreate>[0]> = {}): Score {
  return applyOperation(null, scoreCreate({ id: 'score-1', barCount: 4, ...overrides })).score;
}

function scoreCreate(payload: {
  id: string;
  barCount?: number;
  pickup?: boolean;
  title?: string;
  time?: { beats: number; beatValue: 1 | 2 | 4 | 8 | 16 | 32 };
}): Operation {
  return { type: 'score.create', payload };
}

/** Apply a list in order, the way a batch does. */
function applyAll(from: Score | null, operations: Operation[]): Score {
  let score = from;
  for (const operation of operations) score = applyOperation(score, operation).score;
  if (score === null) throw new Error('no score');
  return score;
}

const quarterAt = (target: string, pitch: string): Operation => ({
  type: 'note.add',
  target,
  payload: { pitch, duration: dur(4) },
});

describe('score.create', () => {
  it('is an operation like any other, which is what keeps replay honest', () => {
    const score = create();
    expect(score.id).toBe('score-1');
    expect(score.bars.map((bar) => bar.number)).toEqual([1, 2, 3, 4]);
  });

  it('opens 32 bars by default, because that is the length of a head', () => {
    expect(applyOperation(null, scoreCreate({ id: 'score-1' })).score.bars).toHaveLength(32);
  });

  it('opens bar 0 for a pickup, so bar 1 is still the first full bar', () => {
    const score = create({ pickup: true, barCount: 4 });
    expect(score.bars.map((bar) => bar.number)).toEqual([0, 1, 2, 3, 4]);
  });

  it('refuses a second create on a score that exists', () => {
    expect(() => applyOperation(create(), scoreCreate({ id: 'score-1' }))).toThrow(
      /already exists/,
    );
  });

  it('refuses anything else as the first operation on a score', () => {
    expect(() => applyOperation(null, quarterAt('bar1.beat1', 'Eb5'))).toThrow(
      /the first operation on a score must be score\.create/,
    );
  });

  it.each([[0], [-1], [1001], [1.5]])('refuses a bar count of %s', (barCount) => {
    expect(() => applyOperation(null, scoreCreate({ id: 's', barCount }))).toThrow(
      /barCount must be a whole number/,
    );
  });

  it('records the bars it made, so replay makes exactly those', () => {
    const applied = applyOperation(null, scoreCreate({ id: 'score-1', barCount: 2 }));
    expect(applied.operation).toEqual({
      type: 'score.create',
      payload: {
        id: 'score-1',
        barCount: 2,
        bars: [
          { id: 'bar-1', number: 1 },
          { id: 'bar-2', number: 2 },
        ],
      },
    });
  });
});

describe('note.add', () => {
  it('places a note at a beat and records the id it assigned', () => {
    const applied = applyOperation(create(), quarterAt('bar1.beat1', 'Eb5'));
    expect(applied.changed).toEqual(['note-1']);
    expect((applied.operation as { payload: { id: string } }).payload.id).toBe('note-1');
    expect(formatPitch(notesOf(applied.score.bars[0]!)[0]!.pitch)).toBe('Eb5');
  });

  it('keeps items in onset order however they arrive', () => {
    const score = applyAll(create(), [
      quarterAt('bar1.beat3', 'G5'),
      quarterAt('bar1.beat1', 'Eb5'),
      quarterAt('bar1.beat2', 'F5'),
    ]);
    expect(score.bars[0]!.items.map((item) => item.onset)).toEqual([0, Q, 2 * Q]);
  });

  it('takes the next free id rather than counting, so a removal cannot cause a collision', () => {
    let score = applyAll(create(), [
      quarterAt('bar1.beat1', 'Eb5'),
      quarterAt('bar1.beat2', 'F5'),
    ]);
    score = applyOperation(score, { type: 'note.rm', target: 'bar1.beat1' }).score;
    const applied = applyOperation(score, quarterAt('bar1.beat3', 'G5'));
    // note-1 is gone and note-2 remains, so the next id is note-3 and not note-2 again.
    expect(applied.changed).toEqual(['note-3']);
  });

  it('accepts a beat past the end of the bar, because ADR-0013 stores it', () => {
    const score = applyOperation(create(), quarterAt('bar1.beat9', 'Eb5')).score;
    expect(score.bars[0]!.items[0]!.onset).toBe(8 * Q);
  });

  it('refuses a second item on an onset that is taken', () => {
    // Two items at one onset is a second voice, and single-voice is load-bearing in layout.
    const score = applyOperation(create(), quarterAt('bar1.beat1', 'Eb5')).score;
    expect(() => applyOperation(score, quarterAt('bar1.beat1', 'G5'))).toThrow(
      /already has a note on it \(note-1\)/,
    );
  });

  it.each([
    ['H5', /is not a pitch/],
    ['Eb', /is not a pitch/],
    ['', /is not a pitch/],
  ])('refuses the pitch %s', (pitch, message) => {
    expect(() => applyOperation(create(), quarterAt('bar1.beat1', pitch))).toThrow(message);
  });

  it('refuses a duration that is not a note value', () => {
    expect(() =>
      applyOperation(create(), {
        type: 'note.add',
        target: 'bar1.beat1',
        payload: { pitch: 'Eb5', duration: { value: 5 as 4, dots: 0 } },
      }),
    ).toThrow(/is not a note value/);
  });

  it('refuses three dots', () => {
    expect(() =>
      applyOperation(create(), {
        type: 'note.add',
        target: 'bar1.beat1',
        payload: { pitch: 'Eb5', duration: { value: 4, dots: 3 as 2 } },
      }),
    ).toThrow(/0, 1 or 2 dots/);
  });

  it('passes the resolver’s own message through when the address misses', () => {
    // Not restated here: the resolver's message is the one that lists the bar's real onsets, and
    // wrapping rather than rewriting is what keeps both surfaces printing the same words.
    const score = applyOperation(create(), quarterAt('bar1.beat1', 'Eb5')).score;
    expect(() => applyOperation(score, { type: 'note.set', target: 'bar1.beat3', payload: {} })).toThrow(
      'bar 1 has no note at beat 3; onsets are 1',
    );
  });
});

describe('note.set', () => {
  const withANote = () => applyOperation(create(), quarterAt('bar1.beat1', 'Eb5')).score;

  it('changes only what the payload names', () => {
    const score = applyOperation(withANote(), {
      type: 'note.set',
      target: 'bar1.beat1',
      payload: { pitch: 'Bb4' },
    }).score;
    const note = notesOf(score.bars[0]!)[0]!;
    expect(formatPitch(note.pitch)).toBe('Bb4');
    expect(note.duration).toEqual(dur(4));
    expect(note.id).toBe('note-1');
  });

  it('accepts an empty payload as a no-op rather than an error', () => {
    const score = applyOperation(withANote(), {
      type: 'note.set',
      target: 'bar1.beat1',
      payload: {},
    }).score;
    expect(score.bars[0]!.items).toEqual(withANote().bars[0]!.items);
  });

  it('refuses to edit a rest as if it were a note', () => {
    const score = applyOperation(create(), {
      type: 'rest.add',
      target: 'bar1.beat1',
      payload: { duration: dur(4) },
    }).score;
    expect(() =>
      applyOperation(score, { type: 'note.set', target: 'bar1.beat1', payload: { pitch: 'C5' } }),
    ).toThrow('bar1.beat1 is a rest, not a note');
  });

  it('addresses by id as readily as by position', () => {
    const score = applyOperation(withANote(), {
      type: 'note.set',
      target: 'note-1',
      payload: { duration: dur(2) },
    }).score;
    expect(notesOf(score.bars[0]!)[0]!.duration).toEqual(dur(2));
  });
});

describe('removing', () => {
  it('removes a note', () => {
    const score = applyAll(create(), [
      quarterAt('bar1.beat1', 'Eb5'),
      { type: 'note.rm', target: 'bar1.beat1' },
    ]);
    expect(score.bars[0]!.items).toEqual([]);
  });

  it('removes a rest, so a rest is not a one-way door', () => {
    const score = applyAll(create(), [
      { type: 'rest.add', target: 'bar1.beat1', payload: { duration: dur(4) } },
      { type: 'rest.rm', target: 'bar1.beat1' },
    ]);
    expect(score.bars[0]!.items).toEqual([]);
  });

  it('will not remove a rest with note.rm', () => {
    const score = applyOperation(create(), {
      type: 'rest.add',
      target: 'bar1.beat1',
      payload: { duration: dur(4) },
    }).score;
    expect(() => applyOperation(score, { type: 'note.rm', target: 'bar1.beat1' })).toThrow(
      'bar1.beat1 is a rest, not a note',
    );
  });
});

describe('metric validity is flagged, never repaired or refused (ADR-0013)', () => {
  it('flags a bar that does not fill the meter', () => {
    const score = applyOperation(create(), quarterAt('bar1.beat1', 'Eb5')).score;
    const bar = score.bars[0]!;
    expect(barMetrics(bar, score.meta.time).status).toBe('under');
    expect(bar.review).toEqual({ flagged: true, reasons: ['metrically-invalid'] });
  });

  it('flags a bar that overflows it, and still stores every note', () => {
    const score = applyAll(create(), [
      { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'Eb5', duration: dur(1) } },
      { type: 'note.add', target: 'bar1.beat2', payload: { pitch: 'F5', duration: dur(1) } },
    ]);
    const bar = score.bars[0]!;
    expect(barMetrics(bar, score.meta.time).status).toBe('over');
    expect(bar.items).toHaveLength(2);
    expect(bar.review.reasons).toContain('metrically-invalid');
  });

  it('clears the flag when the bar comes right', () => {
    const score = applyAll(create(), [
      quarterAt('bar1.beat1', 'Eb5'),
      quarterAt('bar1.beat2', 'F5'),
      quarterAt('bar1.beat3', 'G5'),
      quarterAt('bar1.beat4', 'Ab5'),
    ]);
    expect(score.bars[0]!.review).toEqual({ flagged: false, reasons: [] });
  });

  it('flags every bar of a blank chart, because an empty bar is a short bar', () => {
    expect(create().bars.every((bar) => bar.review.flagged)).toBe(true);
  });

  it('leaves a pickup unflagged when it is merely short, which is the point of one', () => {
    const score = applyOperation(create({ pickup: true }), quarterAt('bar0.beat4', 'G4')).score;
    expect(score.bars[0]!.number).toBe(0);
    expect(score.bars[0]!.review.flagged).toBe(false);
  });

  it('re-flags every bar when the meter changes, without touching a note', () => {
    // A bar of four quarters is exact in 4/4 and overflowing in 3/4. Nothing about the notes
    // changed, so a flag that lived on the notes would now be wrong.
    let score = applyAll(create(), [
      quarterAt('bar1.beat1', 'Eb5'),
      quarterAt('bar1.beat2', 'F5'),
      quarterAt('bar1.beat3', 'G5'),
      quarterAt('bar1.beat4', 'Ab5'),
    ]);
    expect(score.bars[0]!.review.flagged).toBe(false);

    score = applyOperation(score, {
      type: 'meta.set',
      payload: { time: { beats: 3, beatValue: 4 } },
    }).score;
    expect(score.bars[0]!.review.reasons).toContain('metrically-invalid');
    expect(score.bars[0]!.items).toHaveLength(4);
  });

  it('leaves review reasons it did not set alone', () => {
    // v0.2's import sets low-confidence flags, and a rhythm edit has no business clearing them.
    const score = create();
    const seeded: Score = {
      ...score,
      bars: score.bars.map((bar, index) =>
        index === 0 ? { ...bar, review: { flagged: true, reasons: ['low-confidence'] } } : bar,
      ),
    };
    const applied = applyAll(seeded, [
      quarterAt('bar1.beat1', 'Eb5'),
      quarterAt('bar1.beat2', 'F5'),
      quarterAt('bar1.beat3', 'G5'),
      quarterAt('bar1.beat4', 'Ab5'),
    ]);
    expect(applied.bars[0]!.review).toEqual({ flagged: true, reasons: ['low-confidence'] });
  });
});

describe('meta.set', () => {
  it('changes only what it names', () => {
    const score = applyOperation(create({ title: 'Body and Soul' }), {
      type: 'meta.set',
      payload: { composer: 'Johnny Green' },
    }).score;
    expect(score.meta.title).toBe('Body and Soul');
    expect(score.meta.composer).toBe('Johnny Green');
  });

  it('can clear the style line, which is nullable and not merely absent', () => {
    const score = applyAll(create(), [
      { type: 'meta.set', payload: { style: 'Medium swing' } },
      { type: 'meta.set', payload: { style: null } },
    ]);
    expect(score.meta.style).toBeNull();
  });

  it.each([
    [{ key: { tonic: 'H', alter: 0, mode: 'major' } }, /tonic from A to G/],
    [{ key: { tonic: 'C', alter: 5, mode: 'major' } }, /alteration runs -2 to 2/],
    [{ key: { tonic: 'C', alter: 0, mode: 'dorian' } }, /major or minor/],
    [{ time: { beats: 0, beatValue: 4 } }, /1 to 32 beats/],
    [{ time: { beats: 4, beatValue: 5 } }, /is not a beat value/],
  ])('refuses %j', (payload, message) => {
    expect(() =>
      applyOperation(create(), { type: 'meta.set', payload: payload as never }),
    ).toThrow(message);
  });
});

describe('unknown operations', () => {
  it('are refused by name, because an op arriving over HTTP is not well-typed', () => {
    expect(() =>
      applyOperation(create(), { type: 'note.transmogrify' } as unknown as Operation),
    ).toThrow('no such operation: "note.transmogrify"');
  });

  it('carry a failure kind a caller can branch on without reading the prose', () => {
    try {
      applyOperation(create(), { type: 'nope' } as unknown as Operation);
      expect.unreachable();
    } catch (error) {
      expect((error as OperationError).failure).toEqual({ kind: 'unknown-operation', type: 'nope' });
    }
  });
});

describe('replay from empty (ADR-0003)', () => {
  /** The log a small authoring session would have produced. */
  const session: Operation[] = [
    scoreCreate({ id: 'score-1', barCount: 4, title: 'Body and Soul' }),
    { type: 'meta.set', payload: { composer: 'Johnny Green', style: 'Ballad' } },
    quarterAt('bar1.beat1', 'Eb5'),
    quarterAt('bar1.beat2', 'F5'),
    { type: 'rest.add', target: 'bar1.beat3', payload: { duration: dur(4) } },
    quarterAt('bar1.beat4', 'G5'),
    { type: 'note.set', target: 'bar1.n1', payload: { pitch: 'Db5', duration: dur(8) } },
    quarterAt('bar2.beat1', 'Ab5'),
    { type: 'note.rm', target: 'bar1.n4' },
  ];

  it('reproduces the document exactly', () => {
    // The property PLAN.md names. Applying forward and replaying the normalised log must land on
    // the same document, or undo-by-replay would quietly produce a different score.
    let live: Score | null = null;
    const log: Operation[] = [];
    for (const operation of session) {
      const applied = applyOperation(live, operation);
      live = applied.score;
      log.push(applied.operation);
    }

    expect(replay(log)).toEqual(live);
  });

  it('is deterministic: the same log twice gives the same document', () => {
    const log = normalise(session);
    expect(replay(log)).toEqual(replay(log));
  });

  it('reproduces the ids, not merely the shape', () => {
    // Ids are recorded in the payload precisely so this holds regardless of the id policy in
    // force when the operation was first applied.
    // The session assigns note-1, note-2, rest-1, note-3 in bar 1 and note-4 in bar 2, then
    // removes bar1.n4 — which is note-3, the note on beat 4.
    const replayed = replay(normalise(session))!;
    expect(replayed.bars.flatMap((bar) => bar.items.map((item) => item.id))).toEqual([
      'note-1',
      'note-2',
      'rest-1',
      'note-4',
    ]);
  });

  it('survives a prefix, which is what undo walks back to', () => {
    const log = normalise(session);
    for (let length = 1; length <= log.length; length += 1) {
      expect(() => replay(log.slice(0, length))).not.toThrow();
    }
  });

  it('undoing the last operation gives the document before it', () => {
    const log = normalise(session);
    const before = replay(log.slice(0, -1));
    expect(replay(log)).not.toEqual(before);
    // Not an inverse operation anywhere: undo is replay minus the last entry (ADR-0003). The last
    // entry removed note-3, so the document before it still has note-3 in it.
    expect(before!.bars.flatMap((bar) => bar.items.map((item) => item.id))).toContain('note-3');
    expect(replay(log)!.bars.flatMap((bar) => bar.items.map((item) => item.id))).not.toContain(
      'note-3',
    );
  });

  it('returns nothing for an empty log', () => {
    expect(replay([])).toBeNull();
  });
});

/** Fold once to get the normalised log, the way the applier would store it. */
function normalise(operations: Operation[]): Operation[] {
  let score: Score | null = null;
  const log: Operation[] = [];
  for (const operation of operations) {
    const applied = applyOperation(score, operation);
    score = applied.score;
    log.push(applied.operation);
  }
  return log;
}
