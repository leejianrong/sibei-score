import { describe, expect, it } from 'vitest';
import { chartId, keyFrom, newChartOps, problemWith, sampleChartOps, timeFrom } from '../../packages/ui/src/lib/new-chart.js';

describe('the browser new-chart builders (SIB2-270)', () => {
  it('reads keys and times the way the CLI does', () => {
    expect(keyFrom('F#m')).toEqual({ tonic: 'F', alter: 1, mode: 'minor' });
    expect(keyFrom('Bb')).toEqual({ tonic: 'B', alter: -1, mode: 'major' });
    expect(keyFrom('H')).toBeNull();
    expect(timeFrom('6/8')).toEqual({ beats: 6, beatValue: 8 });
    expect(timeFrom('x')).toBeNull();
  });

  it('makes a readable id and a score.create batch', () => {
    expect(chartId('Body & Soul!', 1)).toBe('body-soul-1');
    expect(chartId('', 1)).toBe('chart-1');
    const ops = newChartOps({ title: ' Moanin ', key: 'Cm', time: '4/4', bars: 16, pickup: true }, 'moanin-1');
    expect(ops).toEqual([
      {
        type: 'score.create',
        payload: {
          id: 'moanin-1',
          barCount: 16,
          title: 'Moanin',
          key: { tonic: 'C', alter: 0, mode: 'minor' },
          time: { beats: 4, beatValue: 4 },
          pickup: true,
        },
      },
    ]);
  });

  it('refuses a bar count the server would not want', () => {
    const form = { title: '', key: 'C', time: '4/4', bars: 0, pickup: false };
    expect(problemWith(form)).toMatch(/Bars/);
    expect(problemWith({ ...form, bars: 12 })).toBeNull();
  });

  it('the sample is a create plus twelve chords', () => {
    const ops = sampleChartOps('s');
    expect(ops[0]?.type).toBe('score.create');
    expect(ops.filter((op) => op.type === 'chord.set')).toHaveLength(12);
  });
});
