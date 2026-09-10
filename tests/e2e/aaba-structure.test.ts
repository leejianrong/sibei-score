import { aabaChart, barCountChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import type { LayoutBar, LayoutResult } from '@sibei/layout';
import { renderScoreToPdf } from '@sibei/pdf';
import { describe, expect, it } from 'vitest';

/**
 * The V7 demo, end to end (R3, ADR-0015, ADR-0021): a 32-bar AABA chart with a pickup, rehearsal
 * letters and a repeated A section with 1st/2nd endings, laid out and exported. Line breaks fall at
 * every section boundary, the repeat and its endings land on the right bars, and the pickup sits
 * outside the four-bar grid.
 *
 * The barlines and endings are visual and a person has looked at them (`pnpm proof aaba-chart`); what
 * a test can hold is *where* each one lands, which is what breaks silently when layout or the model
 * wiring drifts.
 */

const allBars = (result: LayoutResult): LayoutBar[] =>
  result.pages.flatMap((page) => page.systems.flatMap((system) => system.bars));

const barNumber = (result: LayoutResult, n: number): LayoutBar =>
  allBars(result).find((bar) => bar.barNumber === n && !bar.isPickup)!;

/** The grid bars of each system, in order, pickup excluded. */
const systemSlots = (result: LayoutResult): number[][] =>
  result.pages.flatMap((page) =>
    page.systems.map((system) => system.bars.filter((bar) => !bar.isPickup).map((bar) => bar.barNumber)),
  );

describe('the AABA demo chart', () => {
  it('breaks the line at every section boundary — the sections at 1, 9, 17, 25 each start a system', () => {
    const slots = systemSlots(layout(aabaChart()));
    // The first grid bar of each system.
    const systemStarts = slots.filter((bars) => bars.length > 0).map((bars) => bars[0]);
    for (const sectionStart of [1, 9, 17, 25]) {
      expect(systemStarts).toContain(sectionStart);
    }
    // And no section start is ever mid-system.
    for (const bars of slots) {
      for (const sectionStart of [9, 17, 25]) {
        if (bars.includes(sectionStart)) expect(bars[0]).toBe(sectionStart);
      }
    }
  });

  it('carries a rehearsal letter on each section, A / B / C / D', () => {
    const result = layout(aabaChart());
    const letterAt = (n: number): string | undefined => {
      const item = barNumber(result, n).items.find((i) => i.kind === 'rehearsalMark');
      return item?.kind === 'rehearsalMark' ? item.text : undefined;
    };
    expect([letterAt(1), letterAt(9), letterAt(17), letterAt(25)]).toEqual(['A', 'B', 'C', 'D']);
  });

  it('renders the repeat around the first A: repeat-start on bar 1, repeat-end on bar 7', () => {
    const result = layout(aabaChart());
    const startItem = barNumber(result, 1).items.find((i) => i.kind === 'barline');
    expect(startItem?.kind === 'barline' ? startItem.barline : null).toBe('repeat-start');
    const endItem = barNumber(result, 7).items.find((i) => i.kind === 'endBarline');
    expect(endItem?.kind === 'endBarline' ? endItem.barline : null).toBe('repeat-end');
  });

  it('renders the 1st and 2nd endings over the correct bars', () => {
    const result = layout(aabaChart());
    const endingAt = (n: number): number[] | null => {
      const item = barNumber(result, n).items.find((i) => i.kind === 'ending');
      return item?.kind === 'ending' ? item.numbers : null;
    };
    expect(endingAt(7)).toEqual([1]); // 1st ending
    expect(endingAt(8)).toEqual([2]); // 2nd ending
    // Nowhere else.
    const withEndings = allBars(result).filter((bar) =>
      bar.items.some((item) => item.kind === 'ending'),
    );
    expect(withEndings.map((bar) => bar.barNumber).sort((a, b) => a - b)).toEqual([7, 8]);
  });

  it('closes the second A with a double bar and ends the chart with a final bar', () => {
    const result = layout(aabaChart());
    const endBarlineAt = (n: number): string | null => {
      const item = barNumber(result, n).items.find((i) => i.kind === 'endBarline');
      return item?.kind === 'endBarline' ? item.barline : null;
    };
    expect(endBarlineAt(16)).toBe('double');
    expect(endBarlineAt(32)).toBe('final');
  });

  it('lays the pickup before bar 1 without it taking a four-bar slot', () => {
    const firstSystem = layout(aabaChart()).pages[0]?.systems[0];
    expect(firstSystem?.bars.map((bar) => bar.barNumber)).toEqual([0, 1, 2, 3, 4]);
    expect(firstSystem?.bars.filter((bar) => !bar.isPickup)).toHaveLength(4);
  });

  it('exports to a valid PDF', async () => {
    const pdf = await renderScoreToPdf(aabaChart());
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  });
});

describe('a section whose length is not a multiple of four', () => {
  it('breaks as 4 / 4 / remainder', () => {
    // An 11-bar chart that is one section from bar 1 lays out 4 / 4 / 3 (ADR-0015).
    const slots = systemSlots(layout(barCountChart(11, { sectionStarts: [1] })));
    expect(slots.map((bars) => bars.length)).toEqual([4, 4, 3]);
  });
});
