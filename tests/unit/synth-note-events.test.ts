import { describe, expect, it } from 'vitest';
import { parseNoteEvents } from '@sibei/model';
import { JITTER_LEVELS, JITTER_PROFILES, generateScore, scoreNoteEventsImport, scoreToNoteEvents } from '@sibei/synth';

const truth = (seed: number) => generateScore({ seed, bars: 8, chords: false, chromatic: 0 });

describe('NoteEvents eval corpus (SIB2-134)', () => {
  it('names its jitter levels', () => {
    expect(JITTER_LEVELS).toEqual(['clean', 'light', 'medium', 'heavy', 'unmarked']);
  });

  it('is reproducible by seed and differs across seeds and levels', () => {
    const a = scoreToNoteEvents(truth(3), { seed: 3, level: 'medium' });
    expect(scoreToNoteEvents(truth(3), { seed: 3, level: 'medium' })).toEqual(a);
    expect(scoreToNoteEvents(truth(4), { seed: 4, level: 'medium' })).not.toEqual(a);
    expect(scoreToNoteEvents(truth(3), { seed: 3, level: 'heavy' })).not.toEqual(a);
  });

  it.each(JITTER_LEVELS)('renders a valid NoteEvents v1 document at %s', (level) => {
    const doc = scoreToNoteEvents(truth(1), { seed: 1, level });
    expect(() => parseNoteEvents(JSON.parse(JSON.stringify(doc)))).not.toThrow();
    expect(doc.beats.some((b) => b.is_downbeat === true)).toBe(JITTER_PROFILES[level].downbeats);
  });

  it('imports a clean rendering almost exactly, and degrades with jitter', () => {
    const mean = (level: (typeof JITTER_LEVELS)[number]): number => {
      const scores = [0, 1, 2, 3].map((seed) => scoreNoteEventsImport(truth(seed), scoreToNoteEvents(truth(seed), { seed, level })).note.f1);
      return scores.reduce((a, b) => a + b, 0) / scores.length;
    };
    expect(mean('clean')).toBeGreaterThan(0.9);
    expect(mean('heavy')).toBeLessThan(mean('clean'));
  });
});
