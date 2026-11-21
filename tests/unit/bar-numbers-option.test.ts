import { describe, expect, it } from 'vitest';
import { parseExportBarNumbers } from '@sibei/api';
import { nastyChart } from '@sibei/fixtures';
import { layout, resolvePageSpec } from '@sibei/layout';
import { renderScoreToSvg } from '@sibei/pdf';
import { renderScorePages } from '@sibei/ui';

/** Whether pages show bar numbers (SIB2-191): drawn by default, a page choice to leave them out. */

const barNumberItems = (spec: Parameters<typeof resolvePageSpec>[0]): number =>
  layout(nastyChart(), resolvePageSpec(spec)).pages.flatMap((p) =>
    p.systems.flatMap((s) => s.bars.flatMap((b) => b.items.filter((i) => i.kind === 'barNumber'))),
  ).length;

describe('bar numbers option', () => {
  it('is on by default and the default render is byte-identical to an explicit yes', () => {
    const score = nastyChart();
    expect(barNumberItems({})).toBeGreaterThan(0);
    expect(renderScoreToSvg(score).map((p) => p.svg)).toEqual(
      renderScoreToSvg(score, { barNumbers: true }).map((p) => p.svg),
    );
  });

  it('leaves every bar number out when off, and only the bar numbers', () => {
    const score = nastyChart();
    expect(barNumberItems({ barNumbers: false })).toBe(0);
    const on = renderScoreToSvg(score).map((p) => p.svg).join('');
    const off = renderScoreToSvg(score, { barNumbers: false }).map((p) => p.svg).join('');
    expect(on).toContain('se-barnumber');
    expect(off).not.toContain('se-barnumber');
    // The systems stay where they were: nothing but the numbers differs.
    expect(off.replace(/<text class="se-barnumber"[^>]*>[^<]*<\/text>/g, '')).toBe(
      on.replace(/<text class="se-barnumber"[^>]*>[^<]*<\/text>/g, ''),
    );
  });

  it('draws the same bytes in the browser and on the server', () => {
    const score = nastyChart();
    expect(renderScorePages(score, { barNumbers: false }).map((p) => p.svg)).toEqual(
      renderScoreToSvg(score, { barNumbers: false }).map((p) => p.svg),
    );
  });

  it('parses the export query: yes or no, nothing else', () => {
    expect(parseExportBarNumbers(null)).toBe(true);
    expect(parseExportBarNumbers('yes')).toBe(true);
    expect(parseExportBarNumbers('no')).toBe(false);
    expect(parseExportBarNumbers('off')).toBeNull();
  });
});
