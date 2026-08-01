import { invalidBarChart } from '@sibei/fixtures';
import type { Bar, Duration, TimeSignature } from '@sibei/model';
import {
  barCapacity,
  barMetrics,
  createIdFactory,
  dur,
  durationTicks,
  invalidBars,
  isMetricallyValid,
  makeBar,
  makeNote,
  makeRest,
  makeScore,
  scoreMetrics,
  TICKS_PER_QUARTER,
} from '@sibei/model';
import { describe, expect, it } from 'vitest';

/**
 * Metric validity is derived and never an invariant: an invalid bar is stored and
 * flagged, never rejected or repaired (ADR-0013). These tests classify; nothing here
 * expects a throw.
 */

function barOf(durations: Duration[], number = 1): Bar {
  const ids = createIdFactory();
  let onset = 0;
  const items = durations.map((duration) => {
    const note = makeNote({ id: ids.next('note'), onset, duration, pitch: 'C5' });
    onset += durationTicks(duration);
    return note;
  });
  return makeBar({ id: 'bar-1', number, items });
}

const FOUR_FOUR: TimeSignature = { beats: 4, beatValue: 4 };
const THREE_FOUR: TimeSignature = { beats: 3, beatValue: 4 };
const SIX_EIGHT: TimeSignature = { beats: 6, beatValue: 8 };

describe('bar capacity', () => {
  it('is the meter expressed in ticks', () => {
    expect(barCapacity(FOUR_FOUR)).toBe(4 * TICKS_PER_QUARTER);
    expect(barCapacity(THREE_FOUR)).toBe(3 * TICKS_PER_QUARTER);
    expect(barCapacity(SIX_EIGHT)).toBe(3 * TICKS_PER_QUARTER);
  });
});

describe('classification in 4/4', () => {
  it('calls four quarters exact', () => {
    const metrics = barMetrics(barOf([dur(4), dur(4), dur(4), dur(4)]), FOUR_FOUR);
    expect(metrics.status).toBe('exact');
    expect(metrics.valid).toBe(true);
    expect(metrics.actual).toBe(metrics.expected);
  });

  it('calls three quarters under', () => {
    const metrics = barMetrics(barOf([dur(4), dur(4), dur(4)]), FOUR_FOUR);
    expect(metrics.status).toBe('under');
    expect(metrics.valid).toBe(false);
  });

  it('calls five quarters over', () => {
    const metrics = barMetrics(barOf([dur(4), dur(4), dur(4), dur(4), dur(4)]), FOUR_FOUR);
    expect(metrics.status).toBe('over');
    expect(metrics.valid).toBe(false);
  });
});

describe('classification in 3/4', () => {
  it('classifies under, exact and over', () => {
    expect(barMetrics(barOf([dur(4), dur(4)]), THREE_FOUR).status).toBe('under');
    expect(barMetrics(barOf([dur(4), dur(4), dur(4)]), THREE_FOUR).status).toBe('exact');
    expect(barMetrics(barOf([dur(2, 1), dur(4)]), THREE_FOUR).status).toBe('over');
  });
});

describe('classification in 6/8', () => {
  it('classifies under, exact and over', () => {
    expect(barMetrics(barOf([dur(8), dur(8), dur(8)]), SIX_EIGHT).status).toBe('under');
    expect(barMetrics(barOf(Array.from({ length: 6 }, () => dur(8))), SIX_EIGHT).status).toBe(
      'exact',
    );
    // A dotted half already fills 6/8; the eighth after it overruns the bar.
    expect(barMetrics(barOf([dur(2, 1), dur(8)]), SIX_EIGHT).status).toBe('over');
  });

  it('treats two dotted quarters as a full bar', () => {
    expect(barMetrics(barOf([dur(4, 1), dur(4, 1)]), SIX_EIGHT).status).toBe('exact');
  });
});

describe('the pickup', () => {
  it('is valid when short, because that is what a pickup is', () => {
    const pickup = barOf([dur(8), dur(8)], 0);
    const metrics = barMetrics(pickup, FOUR_FOUR);
    expect(metrics.status).toBe('under');
    expect(metrics.valid).toBe(true);
  });

  it('is invalid when overfull, but not when empty (KAN-597)', () => {
    expect(isMetricallyValid(barOf([dur(1), dur(4)], 0), FOUR_FOUR)).toBe(false);

    // Bar 0 used to require `actual > 0`, on the reasoning that a pickup exists in order to hold
    // something. `sbscore new --pickup` defeats that: it opens an empty bar 0, so an empty pickup
    // is a starting state rather than a broken document — and the empty rule is now one rule for
    // every bar.
    const empty = makeBar({ id: 'bar-0', number: 0 });
    expect(barMetrics(empty, FOUR_FOUR).status).toBe('empty');
    expect(isMetricallyValid(empty, FOUR_FOUR)).toBe(true);
  });
});

describe('an empty bar', () => {
  /**
   * KAN-597. An empty bar has its own status and is *not* a review case: it is the absence of a
   * rhythm rather than a rhythm the system disagrees with, and a blank 32-bar chart is the normal
   * starting state of every chart. ADR-0013 is untouched — the bar is still stored exactly as
   * written, and nothing here repairs or refuses anything.
   */
  it('is its own status rather than the smallest case of under', () => {
    const metrics = barMetrics(makeBar({ id: 'bar-1', number: 1 }), FOUR_FOUR);
    expect(metrics.status).toBe('empty');
    expect(metrics.actual).toBe(0);
    expect(metrics.valid).toBe(true);
  });

  it('stops being empty the moment it holds anything, rest included', () => {
    // The other half of the decision: "empty" must not become a way to hide a short bar. A rest is
    // a first-class object (Q35) and it is a rhythm, so a bar holding one is under-filled and said
    // to be.
    const withRest = makeBar({
      id: 'bar-1',
      number: 1,
      items: [makeRest({ id: 'rest-1', onset: 0, duration: dur(4) })],
    });
    expect(barMetrics(withRest, FOUR_FOUR).status).toBe('under');
    expect(barMetrics(withRest, FOUR_FOUR).valid).toBe(false);
  });

  it('is not counted among the bars a reader is pointed at', () => {
    const score = makeScore({
      id: 'score-blank',
      bars: Array.from({ length: 8 }, (_unused, index) =>
        makeBar({ id: `bar-${index + 1}`, number: index + 1 }),
      ),
    });
    expect(invalidBars(score)).toEqual([]);
    expect(scoreMetrics(score).every((m) => m.status === 'empty')).toBe(true);
  });
});

describe('a tuplet', () => {
  it('occupies the time it displaces, not the time it is written as', () => {
    const ids = createIdFactory();
    const notes = [0, 1, 2].map((index) =>
      makeNote({
        id: ids.next('note'),
        onset: index * (TICKS_PER_QUARTER / 3),
        duration: dur(4),
        pitch: 'C5',
      }),
    );
    const bar = makeBar({
      id: 'bar-1',
      number: 1,
      items: [...notes, makeNote({ id: 'note-x', onset: TICKS_PER_QUARTER * 2, duration: dur(2), pitch: 'C5' })],
      tuplets: [{ id: 'tuplet-1', actual: 3, normal: 2, memberIds: notes.map((n) => n.id) }],
    });

    // Three quarters as a triplet fill two beats, plus a half note: a full 4/4 bar.
    expect(barMetrics(bar, FOUR_FOUR).status).toBe('exact');
  });
});

describe('the invalid-bar fixture', () => {
  it('is stored and reported rather than rejected', () => {
    const score = invalidBarChart();
    expect(score.bars).toHaveLength(3);

    const flagged = invalidBars(score);
    expect(flagged.map((m) => [m.barNumber, m.status])).toEqual([
      [1, 'under'],
      [3, 'over'],
    ]);
  });
});
