import { describe, expect, it } from 'vitest';
import { OperationError, applyOperation, replay } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { fullBandChart, grandStaffChart, twoVoiceChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';

/** `meta set --layout` (ADR-0041 slice 5a): how a multi-staff chart's systems are broken. */

const set = (score: Score, layoutKind: unknown): Score =>
  applyOperation(score, { type: 'meta.set', payload: { layout: layoutKind } } as Operation).score;

describe('meta.set layout', () => {
  it('sets and clears the system-break policy; lead-sheet is stored as absent', () => {
    const chart = grandStaffChart();
    expect(chart.meta.layout).toBeUndefined();
    const scored = set(chart, 'score');
    expect(scored.meta.layout).toBe('score');
    expect('layout' in set(scored, 'lead-sheet').meta).toBe(false);
    expect('layout' in set(scored, null).meta).toBe(false);
    // Leaving it out of a later meta.set keeps it.
    expect(
      applyOperation(scored, { type: 'meta.set', payload: { title: 'T' } }).score.meta.layout,
    ).toBe('score');
  });

  it('refuses a layout it does not know', () => {
    expect(() => set(grandStaffChart(), 'columns')).toThrow(OperationError);
  });

  it('changes how the systems break, and replays', () => {
    const chart = fullBandChart();
    const shape = (score: Score): number[] => layout(score).pages.flatMap((page) => page.systems.map((system) => system.bars.length));
    const grid = set(chart, 'lead-sheet');
    expect(shape(grid)).not.toEqual(shape(chart));
    const op: Operation = { type: 'meta.set', payload: { layout: 'score' } };
    expect(replay([{ type: 'score.import', payload: { document: chart } } as Operation, op])!.meta.layout).toBe('score');
  });

  it('shows in the text projection only when set, and leaves a lead sheet byte for byte', () => {
    expect(projectScore(grandStaffChart())).not.toContain('layout:');
    expect(projectScore(fullBandChart())).toContain('layout: score (systems break by width)');
  });

  it('reads sensibly for several staves and voices (SIB2-229 5a)', () => {
    // The address hint names an address that exists, and a percussion staff does not say percussion twice.
    expect(projectScore(twoVoiceChart())).toContain('address the rest as s1.v2.bar3.n2');
    expect(projectScore(grandStaffChart())).toContain('address the rest as s2.v1.bar3.n2');
    expect(projectScore(fullBandChart())).toContain('s5 percussion  v1');
  });
});
