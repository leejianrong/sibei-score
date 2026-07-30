import { beatOfOnset, dur, durationTicks, onsetOfBeat, TICKS_PER_QUARTER } from '@sibei/model';
import { describe, expect, it } from 'vitest';

describe('duration ticks', () => {
  it('are exact integers for every supported value', () => {
    for (const value of [1, 2, 4, 8, 16, 32] as const) {
      for (const dots of [0, 1, 2] as const) {
        const ticks = durationTicks(dur(value, dots));
        expect(Number.isInteger(ticks)).toBe(true);
        expect(ticks).toBeGreaterThan(0);
      }
    }
  });

  it('halve as the note value doubles', () => {
    expect(durationTicks(dur(1))).toBe(4 * TICKS_PER_QUARTER);
    expect(durationTicks(dur(2))).toBe(2 * TICKS_PER_QUARTER);
    expect(durationTicks(dur(4))).toBe(TICKS_PER_QUARTER);
    expect(durationTicks(dur(32))).toBe(TICKS_PER_QUARTER / 8);
  });

  it('grow by half for one dot and three quarters for two', () => {
    expect(durationTicks(dur(4, 1))).toBe(TICKS_PER_QUARTER * 1.5);
    expect(durationTicks(dur(4, 2))).toBe(TICKS_PER_QUARTER * 1.75);
    expect(durationTicks(dur(2, 1))).toBe(TICKS_PER_QUARTER * 3);
  });

  it('stay integral for a double-dotted thirty-second inside a triplet', () => {
    const plain = durationTicks(dur(32, 2));
    expect(Number.isInteger((plain * 2) / 3)).toBe(true);
  });
});

describe('beat addressing', () => {
  const time = { beats: 4, beatValue: 4 } as const;

  it('round-trips a beat through its onset', () => {
    for (const beat of [1, 2, 3, 4]) {
      expect(beatOfOnset(onsetOfBeat(beat, time), time)).toBe(beat);
    }
  });

  it('numbers beats from 1, as a musician counts', () => {
    expect(beatOfOnset(0, time)).toBe(1);
    expect(beatOfOnset(TICKS_PER_QUARTER * 2, time)).toBe(3);
  });

  it('reports a fractional beat for an off-beat onset', () => {
    expect(beatOfOnset(TICKS_PER_QUARTER / 2, time)).toBe(1.5);
  });

  it('counts eighths as beats in 6/8', () => {
    const compound = { beats: 6, beatValue: 8 } as const;
    expect(beatOfOnset(TICKS_PER_QUARTER / 2, compound)).toBe(2);
  });
});
