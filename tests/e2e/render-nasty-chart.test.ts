import { nastyChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { renderScoreToPdf } from '@sibei/pdf';
import { describe, expect, it } from 'vitest';

/**
 * The V1 exit condition, minus the part only a person can do: the fixture renders to a
 * PDF, laid out the way a chart should be, reproducibly (ADR-0014, ADR-0015, Q39).
 *
 * Since V1d this path goes through our own engraver rather than VexFlow (ADR-0030), and
 * reproducibility matters more rather than less: the engraver reaches no clock, no
 * counter and no DOM, so byte-identity is a property of the design and worth pinning.
 *
 * Page flow lives in `render-long-form.test.ts` from V3b, where there is a fixture long
 * enough to have a second page rather than only a page setting that would refuse one.
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

  it('renders the same score in either face, and they differ', async () => {
    // A lead sheet is read in a handwritten Real Book face as often as an engraved one,
    // and it is the reader's choice per render (ADR-0030) — so both must reach the PDF.
    const normal = await renderScoreToPdf(nastyChart(), {}, { font: 'normal' });
    const jazz = await renderScoreToPdf(nastyChart(), {}, { font: 'jazz' });

    expect(jazz.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(jazz.equals(normal)).toBe(false);
    // Same layout, so the difference is the engraving rather than the page.
    expect(Math.abs(jazz.length - normal.length) / normal.length).toBeLessThan(0.5);
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
