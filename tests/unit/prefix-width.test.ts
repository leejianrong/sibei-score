import { barCountChart, nastyChart } from '@sibei/fixtures';
import type { LayoutBar } from '@sibei/layout';
import { layout } from '@sibei/layout';
import { describe, expect, it } from 'vitest';

/**
 * `LayoutBar.prefixWidth`: how much of a bar's box its clef, key signature and time
 * signature take up.
 *
 * The contract grew this at the V1b gate. Both adapters need to know where a bar's
 * *music* starts, and neither can work it out — it is layout's own allocation, not a
 * measurement of anyone's glyphs. Keeping it private meant each adapter guessed
 * separately and the two disagreed about the x of a bar's first notehead, which the
 * engraver spike's side-by-side made obvious (`docs/v1b-engraver-spike.md`).
 */

function bars(score = nastyChart()): LayoutBar[] {
  return layout(score)
    .pages.flatMap((page) => page.systems)
    .flatMap((system) => system.bars);
}

describe('the published prefix width', () => {
  it('is zero for a bar that carries no clef, key or time signature', () => {
    const plain = bars().filter(
      (bar) => !bar.prefix.clef && !bar.prefix.keySignature && !bar.prefix.timeSignature,
    );
    expect(plain.length).toBeGreaterThan(10);
    for (const bar of plain) expect(bar.prefixWidth).toBe(0);
  });

  it('grows with each thing the prefix carries', () => {
    // The nasty chart's pickup is the only bar with all three; every other system head
    // repeats the clef and key signature but not the time signature (ADR-0021).
    const heads = bars().filter((bar) => bar.prefix.clef);
    const withTime = heads.filter((bar) => bar.prefix.timeSignature);
    const withoutTime = heads.filter((bar) => !bar.prefix.timeSignature);

    expect(withTime).toHaveLength(1);
    expect(withoutTime.length).toBeGreaterThan(1);

    const full = withTime[0]?.prefixWidth ?? 0;
    const partial = withoutTime[0]?.prefixWidth ?? 0;
    expect(partial).toBeGreaterThan(0);
    expect(full).toBeGreaterThan(partial);
  });

  it('counts one accidental per accidental the key signature draws', () => {
    // C major draws none, so a system head in C is narrower than the same head in Eb.
    const cMajor = bars(barCountChart(4)).filter((bar) => bar.prefix.keySignature);
    const eFlat = bars().filter((bar) => bar.prefix.keySignature && bar.prefix.timeSignature);
    expect(cMajor).toHaveLength(1);
    expect(eFlat).toHaveLength(1);
    expect((eFlat[0]?.prefixWidth ?? 0) - (cMajor[0]?.prefixWidth ?? 0)).toBeGreaterThan(0);
  });

  it('always leaves room for the music inside the bar', () => {
    for (const bar of bars()) {
      expect(bar.prefixWidth).toBeLessThan(bar.width);
    }
  });
});
