import { createIdFactory, dur, makeBar, makeNote, makeRest, makeScore } from '@sibei/model';
import type { ItemToken } from '@sibei/synth';
import {
  chordsEqual,
  computeSequenceMetrics,
  generateScore,
  itemsEqual,
  normalizeChord,
  scoreOmr,
  validBarsRatio,
} from '@sibei/synth';
import { describe, expect, it } from 'vitest';

/**
 * The metrics are the measurement R6 asks for (ADR-0020). They must be exactly right on the corner
 * cases — empty output, perfect output, off-by-one alignment — or a regression in the recogniser
 * could hide behind a metric that rounds it away.
 */

const C4: ItemToken = { kind: 'note', step: 'C', alter: 0, octave: 4, value: 4, dots: 0 };
const D4: ItemToken = { kind: 'note', step: 'D', alter: 0, octave: 4, value: 4, dots: 0 };
const E4: ItemToken = { kind: 'note', step: 'E', alter: 0, octave: 4, value: 4, dots: 0 };
const REST: ItemToken = { kind: 'rest', value: 4, dots: 0 };

describe('computeSequenceMetrics', () => {
  it('scores two empty sequences as a perfect match', () => {
    const m = computeSequenceMetrics<ItemToken>([], [], itemsEqual);
    expect(m).toMatchObject({ matches: 0, precision: 1, recall: 1, f1: 1, accuracy: 1, errorRate: 0 });
  });

  it('scores identical sequences perfectly', () => {
    const seq = [C4, D4, E4];
    const m = computeSequenceMetrics(seq, seq, itemsEqual);
    expect(m).toMatchObject({ matches: 3, precision: 1, recall: 1, f1: 1, accuracy: 1, errorRate: 0 });
  });

  it('is sensitive to an off-by-one insertion', () => {
    // One hallucinated note: everything real is still found (recall 1) but precision drops.
    const truth = [C4, D4, E4];
    const predicted = [C4, D4, REST, E4];
    const m = computeSequenceMetrics(predicted, truth, itemsEqual);
    expect(m.matches).toBe(3);
    expect(m.recall).toBe(1);
    expect(m.precision).toBeCloseTo(3 / 4);
    expect(m.errorRate).toBeCloseTo(1 / 3);
    expect(m.f1).toBeLessThan(1);
  });

  it('is sensitive to a deletion', () => {
    const truth = [C4, D4, E4];
    const predicted = [C4, E4];
    const m = computeSequenceMetrics(predicted, truth, itemsEqual);
    expect(m.matches).toBe(2);
    expect(m.precision).toBe(1);
    expect(m.recall).toBeCloseTo(2 / 3);
  });

  it('scores a completely wrong output at zero', () => {
    const m = computeSequenceMetrics([C4], [D4], itemsEqual);
    expect(m).toMatchObject({ matches: 0, precision: 0, recall: 0, f1: 0 });
    expect(m.errorRate).toBe(1);
  });

  it('scores output against empty truth as all false positives', () => {
    const m = computeSequenceMetrics([C4, D4], [], itemsEqual);
    expect(m.precision).toBe(0);
    expect(m.f1).toBe(0);
  });
});

describe('itemsEqual', () => {
  it('separates pitch, rhythm and kind', () => {
    expect(itemsEqual(C4, C4)).toBe(true);
    expect(itemsEqual(C4, D4)).toBe(false); // pitch
    expect(itemsEqual(C4, { ...C4, value: 8 })).toBe(false); // rhythm
    expect(itemsEqual(C4, REST)).toBe(false); // kind
    expect(itemsEqual(REST, REST)).toBe(true);
  });
});

describe('normalizeChord and chordsEqual', () => {
  it('folds spelling variants of one chord together', () => {
    expect(normalizeChord('CM7')).toBe(normalizeChord('Cmaj7'));
    expect(chordsEqual({ text: 'CM7', onset: 0 }, { text: 'Cmaj7', onset: 0 })).toBe(true);
  });

  it('recognises N.C. and keeps unparseable text verbatim', () => {
    expect(normalizeChord('N.C.')).toBe('N.C.');
    expect(normalizeChord('  ???garbage  ')).toBe('???garbage');
    expect(chordsEqual({ text: 'Cmaj7', onset: 0 }, { text: 'Dm7', onset: 0 })).toBe(false);
  });
});

describe('validBarsRatio', () => {
  it('is 1 for a chart whose bars sum to the meter', () => {
    expect(validBarsRatio(generateScore({ seed: 4 }))).toBe(1);
  });

  it('falls when a bar is metrically invalid', () => {
    const ids = createIdFactory();
    const good = makeBar({
      id: ids.next('bar'),
      number: 1,
      items: [makeNote({ id: ids.next('note'), onset: 0, duration: dur(1), pitch: 'C4' })],
    });
    const short = makeBar({
      id: ids.next('bar'),
      number: 2,
      items: [makeRest({ id: ids.next('rest'), onset: 0, duration: dur(4) })], // one beat in 4/4
    });
    const score = makeScore({ id: 's', bars: [good, short] });
    expect(validBarsRatio(score)).toBe(0.5);
  });
});

describe('scoreOmr', () => {
  it('scores a chart against itself as perfect', () => {
    const score = generateScore({ seed: 17, bars: 8, chords: true });
    const m = scoreOmr(score, score);
    expect(m.note.f1).toBe(1);
    expect(m.chord.f1).toBe(1);
    expect(m.validBarsRatio).toBe(1);
  });

  it('penalises a chart that lost a note', () => {
    const truth = generateScore({ seed: 21, bars: 8, chords: false });
    // Drop the first item of the first non-empty bar.
    const predicted = {
      ...truth,
      bars: truth.bars.map((bar, index) =>
        index === 0 ? { ...bar, items: bar.items.slice(1) } : bar,
      ),
    };
    const m = scoreOmr(predicted, truth);
    expect(m.note.recall).toBeLessThan(1);
  });
});
