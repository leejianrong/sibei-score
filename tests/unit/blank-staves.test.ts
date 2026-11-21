import { describe, expect, it } from 'vitest';
import { parseExportBlankStaves } from '@sibei/api';
import { longFormChart, nastyChart } from '@sibei/fixtures';
import { layout, resolvePageSpec } from '@sibei/layout';
import { renderScoreToSvg } from '@sibei/pdf';
import { renderScorePages } from '@sibei/ui';

/** Empty staves to fill the last page (SIB2-181): off by default, only the room the page has. */

describe('blank staves', () => {
  it('is off by default: the default render is byte-identical to an explicit off', () => {
    const score = nastyChart();
    expect(renderScoreToSvg(score).map((p) => p.svg)).toEqual(
      renderScoreToSvg(score, { blankStaves: false }).map((p) => p.svg),
    );
    const systems = layout(score).pages.flatMap((p) => p.systems);
    expect(systems.some((s) => s.blank === true)).toBe(false);
  });

  it('fills the foot of the last page only, within the margins, and starts no new page', () => {
    const score = longFormChart();
    const plain = layout(score);
    const filled = layout(score, resolvePageSpec({ blankStaves: true }));
    expect(filled.pages).toHaveLength(plain.pages.length);
    const spec = filled.pageSpec;
    filled.pages.forEach((page, index) => {
      const blanks = page.systems.filter((s) => s.blank === true);
      if (index < filled.pages.length - 1) expect(blanks).toHaveLength(0);
      for (const blank of blanks) {
        expect(blank.bars).toEqual([]);
        expect(blank.y + blank.height).toBeLessThanOrEqual(spec.height - spec.margin.bottom);
      }
    });
    const last = filled.pages[filled.pages.length - 1]!;
    expect(last.systems.filter((s) => s.blank === true).length).toBeGreaterThan(0);
    // The real systems are where they were.
    const real = (pages: typeof plain.pages): number[] =>
      pages.flatMap((p) => p.systems.filter((s) => s.blank !== true).map((s) => s.y));
    expect(real(filled.pages)).toEqual(real(plain.pages));
  });

  it('draws a clef and staff per blank system, and the browser matches the server', () => {
    const score = nastyChart();
    const on = renderScoreToSvg(score, { blankStaves: true }).map((p) => p.svg);
    expect(on).not.toEqual(renderScoreToSvg(score).map((p) => p.svg));
    expect(renderScorePages(score, { blankStaves: true }).map((p) => p.svg)).toEqual(on);
  });

  it('parses the export query: yes or no, nothing else', () => {
    expect(parseExportBlankStaves(null)).toBe(false);
    expect(parseExportBlankStaves('no')).toBe(false);
    expect(parseExportBlankStaves('yes')).toBe(true);
    expect(parseExportBlankStaves('maybe')).toBeNull();
  });
});
