import { barCountChart, longFormChart } from '@sibei/fixtures';
import type { LayoutResult, Paper } from '@sibei/layout';
import { layout } from '@sibei/layout';
import { describe, expect, it } from 'vitest';

/**
 * Pagination (Q38): how many systems reach a page, where the next page starts, and what
 * a page break must not disturb.
 *
 * V1 wrote the overflow branch and nothing ever ran it — every fixture in the corpus fit
 * one page, so "a chart flows onto further pages" was a line of code and an assumption
 * rather than a fact. `longFormChart` exists to make it a fact: 64 bars, sixteen systems,
 * two pages on A4 and three on Letter.
 *
 * The counts below are asserted rather than derived. Deriving them here would re-run the
 * same arithmetic the engine runs and agree with it whatever it did, including if it were
 * wrong; a number that moves is a change somebody has to look at.
 */

function pageShape(result: LayoutResult): number[] {
  return result.pages.map((page) => page.systems.length);
}

describe('systems per page, at the default staff size', () => {
  it('puts the 64-bar chart on two A4 pages, eight systems each', () => {
    const result = layout(longFormChart(), { paper: 'a4' });

    expect(result.systemCount).toBe(16);
    expect(pageShape(result)).toEqual([8, 8]);
  });

  it('needs a third Letter page for the same chart, because Letter is shorter', () => {
    const result = layout(longFormChart(), { paper: 'letter' });

    // Same music, same staff size, one fewer system on the first page: the paper is the
    // only thing that changed, and 792pt is 50pt short of A4's 841.89.
    expect(pageShape(result)).toEqual([7, 8, 1]);
  });

  it('fits a whole 32-bar chorus on one A4 page', () => {
    // Worth pinning, because it is why the pagination fixture had to be 64 bars: at this
    // staff size a standard AABA chorus does not spill, and a fixture that only just
    // spilled would be measuring the fixture rather than the engine.
    const chorus = longFormChart();
    const result = layout({
      ...chorus,
      bars: chorus.bars.filter((bar) => bar.number <= 32),
      sections: chorus.sections.filter((section) => section.startBar <= 32),
    });

    expect(pageShape(result)).toEqual([8]);
  });

  it('holds nine plain systems to an A4 page and eight to a Letter one', () => {
    // Uniform 4/4 bars with nothing above or below the staff, so every system is the
    // minimum height and the count is the page arithmetic on its own.
    expect(pageShape(layout(barCountChart(120), { paper: 'a4' }))[0]).toBe(9);
    expect(pageShape(layout(barCountChart(120), { paper: 'letter' }))[0]).toBe(8);

    // The first page is shorter than the rest by exactly the title block.
    expect(pageShape(layout(barCountChart(120), { paper: 'a4' }))[1]).toBe(9);
    expect(pageShape(layout(barCountChart(120), { paper: 'letter' }))[1]).toBe(9);
  });
});

describe('the second page', () => {
  const papers: Paper[] = ['a4', 'letter'];

  it('has no title block', () => {
    for (const paper of papers) {
      const pages = layout(longFormChart(), { paper }).pages;
      expect(pages[0]?.header.length).toBeGreaterThan(0);
      for (const page of pages.slice(1)) {
        expect(page.header, `page ${page.index + 1} of ${paper}`).toEqual([]);
      }
    }
  });

  it('starts its music at the top margin rather than below a header that is not there', () => {
    for (const paper of papers) {
      const result = layout(longFormChart(), { paper });
      const spec = result.pageSpec;

      expect(result.pages[0]?.systems[0]?.y).toBe(spec.margin.top + spec.headerHeight);
      for (const page of result.pages.slice(1)) {
        expect(page.systems[0]?.y, `page ${page.index + 1} of ${paper}`).toBe(spec.margin.top);
      }
    }
  });

  it('breaks only when the next system genuinely will not fit', () => {
    // Guards the other direction from the one above: reserving the header twice, or
    // measuring the page from the wrong edge, would break early and still look tidy.
    for (const paper of papers) {
      const result = layout(longFormChart(), { paper });
      const spec = result.pageSpec;
      const bottom = spec.height - spec.margin.bottom;

      for (const [index, page] of result.pages.entries()) {
        const next = result.pages[index + 1]?.systems[0];
        if (next === undefined) continue;
        const last = page.systems.at(-1);
        const wouldEndAt = (last?.y ?? 0) + (last?.height ?? 0) + spec.systemGap + next.height;
        expect(wouldEndAt, `page ${index + 1} of ${paper} broke early`).toBeGreaterThan(bottom);
      }
    }
  });

  it('keeps every system inside the printable area', () => {
    for (const paper of papers) {
      const result = layout(longFormChart(), { paper });
      const spec = result.pageSpec;

      for (const page of result.pages) {
        for (const system of page.systems) {
          expect(system.y).toBeGreaterThanOrEqual(spec.margin.top);
          expect(system.y + system.height).toBeLessThanOrEqual(spec.height - spec.margin.bottom);
        }
      }
    }
  });
});

describe('the four-bar grid across a page break', () => {
  it('survives it: every system on every page is four bars', () => {
    for (const paper of ['a4', 'letter'] as Paper[]) {
      const result = layout(longFormChart(), { paper });
      const counts = result.pages.flatMap((page) => page.systems.map((s) => s.bars.length));
      expect(new Set(counts), paper).toEqual(new Set([4]));
    }
  });

  it('loses no bar and repeats none: 1 to 64 in order, page after page', () => {
    const result = layout(longFormChart());
    const numbers = result.pages.flatMap((page) =>
      page.systems.flatMap((system) => system.bars.map((bar) => bar.barNumber)),
    );

    expect(numbers).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
  });

  it('puts no system on two pages', () => {
    const result = layout(longFormChart());
    const seen = new Set<number>();

    for (const page of result.pages) {
      for (const system of page.systems) {
        expect(seen.has(system.index)).toBe(false);
        seen.add(system.index);
      }
    }
    expect(seen.size).toBe(result.systemCount);
  });

  it('lands the break on a section boundary here, so the bridge heads page 2', () => {
    // Not a rule — the grid decides where systems fall and the page takes as many as fit
    // — but it is what this chart does, and it is the case worth having a fixture for:
    // a rehearsal mark as the first ink on a page with no title above it.
    const result = layout(longFormChart());

    expect(result.pages[0]?.systems.at(-1)?.bars.at(-1)?.barNumber).toBe(32);
    expect(result.pages[1]?.systems[0]?.bars[0]?.barNumber).toBe(33);
  });

  it('cuts a tie in half at the break, one end on each page', () => {
    // Ties are planned across the whole score before pages exist, so a page break is
    // just a system break to them. Bar 32 ties into bar 33, which is the break.
    const result = layout(longFormChart());
    const opening = result.pages[0]?.systems.at(-1)?.ties ?? [];
    const closing = result.pages[1]?.systems[0]?.ties ?? [];

    expect(opening).toHaveLength(1);
    expect(opening[0]?.toNoteId).toBeNull();
    expect(closing).toHaveLength(1);
    expect(closing[0]?.fromNoteId).toBeNull();
  });
});
