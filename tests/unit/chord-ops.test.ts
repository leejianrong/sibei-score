import { describe, expect, it } from 'vitest';
import { OperationError, applyOperation, replay } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { TICKS_PER_QUARTER, projectScore, reviewSummary } from '@sibei/model';
import type { Chord, Score } from '@sibei/model';

/**
 * `chord.set` and `chord.rm` through the applier (V5, Q32, ADR-0012). Pure, no store — the whole
 * point of ADR-0003 is that everything a chord operation does is decided here and can be asserted
 * here, replay included.
 */

const Q = TICKS_PER_QUARTER;

function fresh(): Score {
  return applyOperation(null, { type: 'score.create', payload: { id: 'score-1', barCount: 4 } }).score;
}

function applyAll(operations: Operation[]): Score {
  let score: Score | null = fresh();
  for (const operation of operations) score = applyOperation(score, operation).score;
  return score as Score;
}

const set = (target: string, text: string): Operation => ({ type: 'chord.set', target, payload: { text } });

const chordsOf = (score: Score, barNumber: number): Chord[] =>
  score.bars.find((bar) => bar.number === barNumber)?.chords ?? [];

describe('placing chords at a beat within a bar (Q32)', () => {
  it('sets a chord on beat 1, anchored to that onset', () => {
    const applied = applyOperation(fresh(), set('bar1.beat1', 'Cmaj7'));
    const chords = chordsOf(applied.score, 1);
    expect(chords).toHaveLength(1);
    expect(chords[0]).toMatchObject({ id: 'chord-1', onset: 0, text: 'Cmaj7' });
    expect(applied.changed).toEqual(['chord-1']);
  });

  it('lets two chords share a bar at different beats, kept in onset order', () => {
    const score = applyAll([set('bar1.beat3', 'Bb7'), set('bar1.beat1', 'Ebm7')]);
    const chords = chordsOf(score, 1);
    expect(chords.map((chord) => [chord.onset, chord.text])).toEqual([
      [0, 'Ebm7'],
      [2 * Q, 'Bb7'],
    ]);
  });

  it('anchors to a beat even where no note sits — a chord is not a note (Q32)', () => {
    // Beat 3 has no note on it; a chord still goes there, because chord addressing is by beat, not
    // by an existing onset the way note ordinal addressing is.
    const score = applyOperation(fresh(), set('bar2.beat3', 'F#m7b5')).score;
    expect(chordsOf(score, 2)).toHaveLength(1);
    expect(chordsOf(score, 2)[0]).toMatchObject({ onset: 2 * Q, text: 'F#m7b5' });
  });

  it('set is an upsert: a second set on a beat replaces the chord there, keeping its id', () => {
    const score = applyAll([set('bar1.beat1', 'Cmaj7'), set('bar1.beat1', 'Am7')]);
    const chords = chordsOf(score, 1);
    expect(chords).toHaveLength(1);
    expect(chords[0]).toMatchObject({ id: 'chord-1', text: 'Am7' });
  });
});

describe('removing chords', () => {
  it('rm by beat drops just that chord', () => {
    const score = applyAll([set('bar1.beat1', 'Cmaj7'), set('bar1.beat3', 'Bb7'), { type: 'chord.rm', target: 'bar1.beat1' }]);
    expect(chordsOf(score, 1).map((chord) => chord.text)).toEqual(['Bb7']);
  });

  it('rm by id works too', () => {
    const score = applyAll([set('bar1.beat1', 'Cmaj7'), { type: 'chord.rm', target: 'chord-1' }]);
    expect(chordsOf(score, 1)).toHaveLength(0);
  });

  it('removing a chord that is not there is an address error, not a silent no-op', () => {
    expect(() => applyOperation(fresh(), { type: 'chord.rm', target: 'bar1.beat1' })).toThrow(OperationError);
  });
});

describe('unparseable text is stored, flagged, never rejected (ADR-0012)', () => {
  it('keeps a garbled chord verbatim and flags it unparsed-chord', () => {
    const applied = applyOperation(fresh(), set('bar1.beat1', 'solo break'));
    const chord = chordsOf(applied.score, 1)[0] as Chord;
    expect(chord.text).toBe('solo break');
    expect(chord.review).toEqual({ flagged: true, reasons: ['unparsed-chord'] });
    expect(reviewSummary(applied.score).anythingFlagged).toBe(true);
  });

  it('does not flag a chord the grammar reads, N.C. included', () => {
    for (const text of ['Cmaj7', 'Bb13#11', 'N.C.']) {
      const chord = chordsOf(applyOperation(fresh(), set('bar1.beat1', text)).score, 1)[0] as Chord;
      expect(chord.review.flagged, `${text} should not be flagged`).toBe(false);
    }
  });

  it('refuses empty text, pointing at chord rm instead', () => {
    expect(() => applyOperation(fresh(), set('bar1.beat1', '   '))).toThrow(OperationError);
  });
});

describe('replay reproduces the document exactly (ADR-0003)', () => {
  it('a chord log replays to an identical score, recorded ids and all', () => {
    const operations = [
      { type: 'score.create', payload: { id: 'score-1', barCount: 4 } },
      set('bar1.beat1', 'Cmaj7'),
      set('bar1.beat3', 'Bb7'),
      set('bar1.beat1', 'Am7'),
      { type: 'chord.rm', target: 'bar1.beat3' },
    ] as Operation[];

    // Feed each op back through the applier as the log records it (recorded id filled in).
    const logged: Operation[] = [];
    let score: Score | null = null;
    for (const operation of operations) {
      const applied = applyOperation(score, operation);
      score = applied.score;
      logged.push(applied.operation);
    }

    expect(replay(logged)).toEqual(score);
  });
});

describe('the chord reaches the text projection at its beat (ADR-0009)', () => {
  it('shows two chords in one bar in the grid', () => {
    const score = applyAll([set('bar1.beat1', 'Ebm7'), set('bar1.beat3', 'Bb7')]);
    const projection = projectScore(score);
    const chordLine = projection.split('\n').find((line) => line.includes('Ebm7'));
    expect(chordLine).toBeDefined();
    expect(chordLine).toContain('Ebm7');
    expect(chordLine).toContain('Bb7');
    // Beat placement: the beat-1 chord starts at the left of the cell, the beat-3 chord to its right.
    expect((chordLine as string).indexOf('Ebm7')).toBeLessThan((chordLine as string).indexOf('Bb7'));
  });

  it('marks an unparseable chord with ! in the projection', () => {
    const score = applyOperation(fresh(), set('bar1.beat1', 'wat')).score;
    expect(projectScore(score)).toContain('wat!');
  });
});
