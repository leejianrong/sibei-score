import type { KeySignature } from '@sibei/model';
import { scoreMetrics } from '@sibei/model';
import { isChord } from '@sibei/music';
import { extractLabels, generateScore } from '@sibei/synth';
import { describe, expect, it } from 'vitest';

/**
 * The corpus generator must be deterministic (a seed reproduces the chart, ADR-0031) and its output
 * must be plausible ground truth: bars that sum to the meter, pitches spelled to the key, real
 * chord symbols. Anything less and the harness would be scoring against noise (ADR-0020).
 */

const D_MAJOR: KeySignature = { tonic: 'D', alter: 0, mode: 'major' };

describe('generateScore', () => {
  it('is deterministic in the seed', () => {
    expect(generateScore({ seed: 123 })).toEqual(generateScore({ seed: 123 }));
  });

  it('produces different charts for different seeds', () => {
    expect(generateScore({ seed: 1 })).not.toEqual(generateScore({ seed: 2 }));
  });

  it('honours the bar count', () => {
    expect(generateScore({ seed: 5, bars: 12 }).bars).toHaveLength(12);
  });

  it('fills every bar exactly to the meter, so the ground truth is metrically valid', () => {
    // Across many seeds — the greedy filler must never leave a short or long bar (ADR-0013).
    for (let seed = 0; seed < 40; seed += 1) {
      const score = generateScore({ seed });
      const invalid = scoreMetrics(score).filter((bar) => !bar.valid);
      expect(invalid, `seed ${seed} produced invalid bars`).toEqual([]);
    }
  });

  it('spells the melody to the key: D major has F# and C#, never F natural or C natural', () => {
    const score = generateScore({ seed: 8, key: D_MAJOR, bars: 16, chords: false });
    const notes = score.bars.flatMap((bar) =>
      bar.items.filter((item) => item.kind === 'note'),
    );
    for (const note of notes) {
      if (note.kind !== 'note') continue;
      if (note.pitch.step === 'F') expect(note.pitch.alter).toBe(1);
      if (note.pitch.step === 'C') expect(note.pitch.alter).toBe(1);
    }
  });

  it('emits parseable diatonic chord symbols when chords are on', () => {
    const labels = extractLabels(generateScore({ seed: 3, bars: 8, chords: true }));
    const texts = labels.bars.flatMap((bar) => bar.chords.map((chord) => chord.text));
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(isChord(text)).toBe(true);
  });

  it('omits chords when asked', () => {
    const labels = extractLabels(generateScore({ seed: 3, chords: false }));
    expect(labels.bars.flatMap((bar) => bar.chords)).toEqual([]);
  });
});
