import { barCountChart, nastyChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { renderScoreToPdf } from '@sibei/pdf';
import { describe, expect, it } from 'vitest';

/**
 * The V1 exit condition, minus the part only a person can do: the fixture renders to a
 * PDF, laid out the way a chart should be, reproducibly (ADR-0014, ADR-0015, Q39).
 */

describe('the nasty chart as a PDF', () => {
  it('puts three systems on the first page for the 11-bar A section, laid out 4 / 4 / 3', () => {
    const result = layout(nastyChart());
    const firstPage = result.pages[0];

    const aSection = firstPage?.systems.slice(0, 3) ?? [];
    // Grid slots, so the pickup sharing the first line does not count as one.
    const slots = aSection.map((system) => system.bars.filter((bar) => !bar.isPickup));
    expect(slots.map((bars) => bars.length)).toEqual([4, 4, 3]);
    expect(slots.flat().map((bar) => bar.barNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    // Exactly three: the next section starts a new system rather than filling this one.
    expect(firstPage?.systems[3]?.bars[0]?.barNumber).toBe(12);
  });

  it('renders before bar 1 without the pickup consuming a four-bar slot', () => {
    const result = layout(nastyChart());
    const firstSystem = result.pages[0]?.systems[0];

    // Five boxes on the line, but only four of them are grid bars.
    expect(firstSystem?.bars.map((bar) => bar.barNumber)).toEqual([0, 1, 2, 3, 4]);
    expect(firstSystem?.bars.filter((bar) => !bar.isPickup)).toHaveLength(4);
  });

  it('is a valid PDF at A4 size', async () => {
    const pdf = await renderScoreToPdf(nastyChart());

    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('%%EOF');
    expect(pdf.length).toBeGreaterThan(10_000);
  });

  it('produces byte-identical output when rendered twice', async () => {
    const first = await renderScoreToPdf(nastyChart());
    const second = await renderScoreToPdf(nastyChart());

    expect(second.equals(first)).toBe(true);
  });

  it('pins its metadata rather than stamping a time', async () => {
    const pdf = (await renderScoreToPdf(nastyChart())).toString('latin1');

    expect(pdf).toContain('sibei-score');
    // 1 January 1970: any real timestamp would break reproducibility.
    expect(pdf).toContain('D:19700101');
  });

  it('differs between A4 and Letter, and both are valid', async () => {
    const a4 = await renderScoreToPdf(nastyChart(), { paper: 'a4' });
    const letter = await renderScoreToPdf(nastyChart(), { paper: 'letter' });

    expect(a4.equals(letter)).toBe(false);
    expect(letter.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    const a4Spec = layout(nastyChart(), { paper: 'a4' }).pageSpec;
    const letterSpec = layout(nastyChart(), { paper: 'letter' }).pageSpec;
    expect(a4Spec.widthPt).not.toBe(letterSpec.widthPt);
  });
});

describe('page flow', () => {
  it('starts a second page rather than overrunning the first', () => {
    // Enough four-bar systems that no page setting could fit them on one sheet.
    const result = layout(barCountChart(120, {}));

    expect(result.pages.length).toBeGreaterThan(1);
    expect(result.systemCount).toBe(30);
    expect(result.pages.reduce((sum, page) => sum + page.systems.length, 0)).toBe(30);
  });

  it('keeps the four-bar grid intact across a page break', () => {
    const result = layout(barCountChart(120, {}));
    const counts = result.pages.flatMap((page) => page.systems.map((s) => s.bars.length));

    expect(new Set(counts)).toEqual(new Set([4]));
  });

  it('holds every system inside the printable area', () => {
    const result = layout(barCountChart(120, {}));
    const spec = result.pageSpec;

    for (const page of result.pages) {
      for (const system of page.systems) {
        expect(system.y).toBeGreaterThanOrEqual(spec.margin.top);
        expect(system.y + system.height).toBeLessThanOrEqual(spec.height - spec.margin.bottom);
      }
      // Only the first page reserves room for the title block.
      const first = page.systems[0];
      if (page.index === 0) {
        expect(first?.y).toBeGreaterThanOrEqual(spec.margin.top + spec.headerHeight);
      }
    }
  });
});
