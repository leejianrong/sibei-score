import { barCountChart, nastyChart } from '@sibei/fixtures';
import { BARS_PER_SYSTEM, layout, planSystems } from '@sibei/layout';
import { describe, expect, it } from 'vitest';

/** The four-bar grid, and what a section boundary does to it (ADR-0015). */

function systemShape(barCount: number, sectionStarts?: number[]): number[] {
  const score = barCountChart(barCount, sectionStarts === undefined ? {} : { sectionStarts });
  return planSystems(score).map((system) => system.bars.length);
}

describe('the four-bar grid', () => {
  it('groups bars four to a line', () => {
    expect(BARS_PER_SYSTEM).toBe(4);
    expect(systemShape(1)).toEqual([1]);
    expect(systemShape(3)).toEqual([3]);
    expect(systemShape(4)).toEqual([4]);
    expect(systemShape(5)).toEqual([4, 1]);
    expect(systemShape(8)).toEqual([4, 4]);
    expect(systemShape(11)).toEqual([4, 4, 3]);
  });

  it('has no systems at all for an empty score', () => {
    expect(systemShape(0)).toEqual([]);
  });
});

describe('section boundaries', () => {
  it('breaks the line mid-grid, so an 11-bar section lays out 4 / 4 / 3', () => {
    // Sections at bars 1 and 12: the first is eleven bars long.
    expect(systemShape(19, [1, 12])).toEqual([4, 4, 3, 4, 4]);
  });

  it('breaks a line even when the section is short', () => {
    expect(systemShape(8, [1, 3])).toEqual([2, 4, 2]);
  });

  it('creates no empty system when a section starts on a line boundary', () => {
    expect(systemShape(8, [1, 5])).toEqual([4, 4]);
    expect(systemShape(12, [1, 5, 9])).toEqual([4, 4, 4]);
  });

  it('needs no section on bar 1 to lay out', () => {
    expect(systemShape(6, [5])).toEqual([4, 2]);
  });
});

describe('the pickup', () => {
  it('sits on the first system and consumes no four-bar slot', () => {
    const score = barCountChart(8, { withPickup: true });
    const systems = planSystems(score);

    expect(systems.map((s) => s.bars.length)).toEqual([4, 4]);
    expect(systems[0]?.pickup?.number).toBe(0);
    expect(systems[1]?.pickup).toBeNull();
  });

  it('is the only thing on its line when the score has nothing else', () => {
    const score = barCountChart(0, { withPickup: true });
    const systems = planSystems(score);

    expect(systems).toHaveLength(1);
    expect(systems[0]?.pickup?.number).toBe(0);
    expect(systems[0]?.bars).toEqual([]);
  });

  it('is laid out before bar 1 and narrower than it', () => {
    const result = layout(barCountChart(4, { withPickup: true }));
    const bars = result.pages[0]?.systems[0]?.bars ?? [];

    const pickup = bars[0];
    const barOne = bars[1];
    expect(pickup?.barNumber).toBe(0);
    expect(pickup?.isPickup).toBe(true);
    expect(barOne?.barNumber).toBe(1);
    expect(pickup?.x).toBeLessThan(barOne?.x ?? 0);
    expect(pickup?.width).toBeLessThan(barOne?.width ?? 0);
  });
});

describe('the nasty chart', () => {
  it('lays its 11-bar A section out as 4 / 4 / 3', () => {
    const systems = planSystems(nastyChart());
    expect(systems.slice(0, 3).map((s) => s.bars.length)).toEqual([4, 4, 3]);
    expect(systems.slice(0, 3).flatMap((s) => s.bars.map((b) => b.number))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  it('starts a new system at the B section rather than mid-line', () => {
    const systems = planSystems(nastyChart());
    expect(systems[3]?.bars[0]?.number).toBe(12);
  });
});

describe('justification', () => {
  it('fills the system width exactly, whatever the bar count', () => {
    for (const barCount of [1, 2, 3, 4, 11]) {
      const result = layout(barCountChart(barCount));
      const spec = result.pageSpec;
      for (const page of result.pages) {
        for (const system of page.systems) {
          const last = system.bars.at(-1);
          const right = (last?.x ?? 0) + (last?.width ?? 0);
          expect(right).toBeCloseTo(spec.width - spec.margin.right, 6);
          expect(system.bars[0]?.x).toBeCloseTo(spec.margin.left, 6);
        }
      }
    }
  });

  it('leaves no gaps or overlaps between adjacent bars', () => {
    const result = layout(nastyChart());
    for (const page of result.pages) {
      for (const system of page.systems) {
        for (let i = 1; i < system.bars.length; i += 1) {
          const previous = system.bars[i - 1];
          const current = system.bars[i];
          expect(current?.x).toBeCloseTo((previous?.x ?? 0) + (previous?.width ?? 0), 6);
        }
      }
    }
  });
});
