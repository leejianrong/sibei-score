import { barCountChart, longFormChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { renderScoreToPdf, renderScoreToSvg } from '@sibei/pdf';
import { describe, expect, it } from 'vitest';

/**
 * The V3 exit condition for pagination and the metadata header (Q37, Q38), minus the part
 * only a person can do — for that, `pnpm proof long-form` and look at page 2.
 *
 * These go through the whole render path rather than through `layout` alone, because the
 * thing V1 never proved was not the arithmetic but the page: a second page that layout
 * describes correctly and the engraver draws with a phantom title block, or with its
 * first system half off the top, would pass every assertion in `tests/unit/pagination`.
 */

/** The bar number that heads each system, in the order the markup draws them. */
function barNumbersIn(svg: string): number[] {
  return [...svg.matchAll(/class="se-barnumber"[^>]*>(\d+)</g)].map((match) => Number(match[1]));
}

describe('the long-form chart as a PDF', () => {
  it('is two A4 pages', async () => {
    const pdf = (await renderScoreToPdf(longFormChart())).toString('latin1');

    expect(pdf.startsWith('%PDF-')).toBe(true);
    expect(pdf).toContain('/Count 2');
    expect(pdf.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g)).toHaveLength(2);
  });

  it('renders both pages, and only the first carries the title block', () => {
    const pages = renderScoreToSvg(longFormChart());

    expect(pages.map((page) => page.index)).toEqual([0, 1]);
    expect(pages[0]?.svg).toContain('The Long Way Home');
    expect(pages[0]?.svg).toContain('se-title');
    expect(pages[1]?.svg).not.toContain('se-title');
    expect(pages[1]?.svg).not.toContain('se-composer');
    expect(pages[1]?.svg).not.toContain('se-style');
    expect(pages[1]?.svg).not.toContain('The Long Way Home');
  });

  it('draws page 2 with the music page 2 was laid out with', () => {
    // The bars a page holds are layout's business; that the engraver drew *those* bars
    // and not the previous page's is the part a rendered page can get wrong on its own.
    // A bar number heads every system, so the pages say which bars they are showing.
    const pages = renderScoreToSvg(longFormChart());

    expect(barNumbersIn(pages[0]?.svg ?? '')).toEqual([5, 9, 13, 17, 21, 25, 29]);
    expect(barNumbersIn(pages[1]?.svg ?? '')).toEqual([33, 37, 41, 45, 49, 53, 57, 61]);
  });

  it('produces byte-identical output when rendered twice', async () => {
    const first = await renderScoreToPdf(longFormChart());
    const second = await renderScoreToPdf(longFormChart());

    expect(second.equals(first)).toBe(true);
  });

  it('renders three Letter pages for the same chart', async () => {
    const pdf = (await renderScoreToPdf(longFormChart(), { paper: 'letter' })).toString('latin1');

    expect(pdf).toContain('/Count 3');
    expect(pdf.match(/\/MediaBox \[0 0 612 792\]/g)).toHaveLength(3);
  });

  it('renders both faces across the break', async () => {
    // A face is a render-time argument (ADR-0030), and nothing about pagination may
    // depend on which one is chosen: the layout is the same, so the pages are too.
    const jazz = await renderScoreToPdf(longFormChart(), {}, { font: 'jazz' });
    const normal = await renderScoreToPdf(longFormChart(), {}, { font: 'normal' });

    expect(jazz.toString('latin1')).toContain('/Count 2');
    expect(jazz.equals(normal)).toBe(false);
  });
});

describe('the metadata header', () => {
  it('prints the title, the composer and the style line, and nothing else (Q37)', () => {
    const result = layout(longFormChart());
    const header = result.pages[0]?.header ?? [];

    expect(header.map((text) => text.role)).toEqual(['title', 'style', 'composer']);
    expect(header.map((text) => text.text)).toEqual([
      'The Long Way Home',
      'Medium swing',
      'sibei-score',
    ]);
  });

  it('states the key on the stave rather than in the header (Q37, amended)', () => {
    // Q37 assumed the key belonged in the header text. It does not: a lead sheet states
    // its key with the key signature, and printing "key Bb" above a chart already showing
    // two flats is redundant. Two flats, at the head of every system, on every page.
    const result = layout(longFormChart());
    const header = result.pages[0]?.header ?? [];

    expect(header.some((text) => /\bkey\b/i.test(text.text))).toBe(false);

    for (const page of result.pages) {
      for (const system of page.systems) {
        const first = system.bars[0];
        const signature = first?.items.find((item) => item.kind === 'keySignature');
        expect(signature, `system ${system.index} has no key signature`).toBeDefined();
        expect(signature?.kind === 'keySignature' && signature.fifths).toBe(-2);
      }
    }
  });

  it('reaches the PDF info dictionary as well as the page', async () => {
    const pdf = (await renderScoreToPdf(longFormChart())).toString('latin1');

    expect(pdf).toContain('The Long Way Home');
    expect(pdf).toContain('sibei-score');
    expect(pdf).toContain('D:19700101');
  });
});

describe('page flow', () => {
  /**
   * The extreme case, kept from V1: 120 bars is more than any page setting could hold, so
   * it exercises the loop rather than one break. The long-form chart is the realistic one.
   */
  it('starts a second page rather than overrunning the first', () => {
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
      // Only the first page reserves room for the title block, and only for the rows the
      // block actually drew: `barCountChart` has a title and no composer, so its band is
      // shorter than a full block's and the assertion is against its own ink (KAN-525).
      const first = page.systems[0];
      if (page.index === 0) {
        const lowest = Math.max(...page.header.map((text) => text.y));
        expect(page.header.length).toBeGreaterThan(0);
        expect(first?.y).toBeGreaterThan(lowest);
        expect(first?.y).toBeLessThan(spec.margin.top + spec.headerHeight);
      }
    }
  });
});
