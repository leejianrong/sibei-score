import { ENGRAVED_ITEM_KINDS, engravePage } from '@sibei/engrave';
import { beamingChart, everyGlyphChart, nastyChart } from '@sibei/fixtures';
import type { LayoutResult } from '@sibei/layout';
import { LAYOUT_BAR_ITEM_KINDS, STAFF_SPACE, layout } from '@sibei/layout';
import { notesInReadingOrder } from '@sibei/model';
import { describe, expect, it } from 'vitest';

/**
 * The V1b integration claims (`SLICES.md`): the spike adapter renders the fixture
 * without throwing, it consumes only the layout contract, and **both adapters run off
 * the same layout** — so the side-by-side that ADR-0030's gate looks at is a comparison
 * of engraving, not of two different layouts.
 *
 * The last point is the one worth testing rather than asserting. Two renderers agreeing
 * on where the staff and the noteheads sit is what makes a visual difference between
 * them attributable to engraving.
 */

function engraved(result: LayoutResult): string {
  return engravePage(result, 0).svg;
}

/** The y of every `se-stafflines` rect, back-centred to the line it represents. */
function engravedStaffLines(svg: string): number[] {
  return [...svg.matchAll(/class="se-stafflines" x="[\d.]+" y="([\d.]+)" [^/]*height="([\d.]+)"/g)]
    .map((match) => Number(match[1]) + Number(match[2]) / 2)
    .map((y) => Number(y.toFixed(3)));
}

describe('the engraver behind the same seam', () => {
  it('engraves the nasty chart without throwing', () => {
    const result = layout(nastyChart());
    for (const page of result.pages) {
      expect(() => engravePage(result, page.index)).not.toThrow();
    }
  });

  it('draws a notehead for every note in the score', () => {
    const score = nastyChart();
    const result = layout(score);
    const svg = result.pages.map((page) => engravePage(result, page.index).svg).join('');
    const noteheads = [...svg.matchAll(/class="se-glyph se-notehead\w+"/g)].length;
    expect(noteheads).toBe([...notesInReadingOrder(score)].length);
  });

  it('draws every kind the layout contract can emit, and skips none', () => {
    // The same claim `tests/integration/glyph-coverage.test.ts` makes of the VexFlow
    // adapter, asserted against the contract rather than against a remembered list.
    expect([...ENGRAVED_ITEM_KINDS].sort()).toEqual([...LAYOUT_BAR_ITEM_KINDS].sort());

    for (const score of [nastyChart(), everyGlyphChart()]) {
      const result = layout(score);
      for (const page of result.pages) {
        expect(engravePage(result, page.index).skipped).toEqual([]);
      }
    }
  });

  it('is byte-identical run to run', () => {
    // The same requirement the PDF path carries (Q39). Nothing here reaches a clock, a
    // counter or a DOM, so this should hold by construction — and now does so on record.
    const result = layout(nastyChart());
    expect(engraved(result)).toBe(engraved(layout(nastyChart())));
  });

  it('needs no DOM: the same call works with `document` undefined', () => {
    // The VexFlow adapter could not do this: it built elements with the global document,
    // which is why the PDF path used to install jsdom. Worth pinning, because losing it
    // would quietly put a headless DOM back on the server render path.
    const globals = globalThis as Record<string, unknown>;
    const saved = globals['document'];
    delete globals['document'];
    try {
      expect(engraved(layout(beamingChart())).length).toBeGreaterThan(0);
    } finally {
      if (saved !== undefined) globals['document'] = saved;
    }
  });
});

describe('the staff, where layout said to put it', () => {
  it('draws five lines a staff space apart, per system', () => {
    const result = layout(nastyChart());
    const lines = engravedStaffLines(engraved(result));
    const systems = result.pages[0]?.systems.length ?? 0;
    expect(systems).toBeGreaterThan(1);
    expect(lines).toHaveLength(systems * 5);

    for (let index = 0; index < lines.length; index += 5) {
      const group = lines.slice(index, index + 5);
      for (let line = 1; line < group.length; line += 1) {
        expect((group[line] ?? 0) - (group[line - 1] ?? 0)).toBeCloseTo(STAFF_SPACE, 6);
      }
    }
  });

  it('puts the top staff line exactly where layout said the stave goes', () => {
    const result = layout(nastyChart());
    const tops = (result.pages[0]?.systems ?? []).map((system) => system.staveY);
    expect(engravedStaffLines(engraved(result)).filter((y) => tops.includes(y))).toHaveLength(
      tops.length,
    );
  });
});

describe('flags and beams', () => {
  it('draws no flag on a beamed note, and one on an eighth with nothing to beam to', () => {
    // The V1 defect, restated for this adapter: a beamed note that also draws its flag.
    // `beamingChart` is ten beamed notes in bar 1 and exactly one lone eighth in bar 2.
    const svg = engraved(layout(beamingChart()));
    const flags = [...svg.matchAll(/class="se-glyph se-flag\w+"/g)].length;
    expect(flags).toBe(1);
  });

  it('beams the nasty chart into the same number of groups as VexFlow', () => {
    // Six groups: the pickup, bar 2, bar 3's triplet, bar 6's sixteenths, bar 13, bar 18.
    // Bar 6 carries two beams, so the segment count exceeds the group count by one.
    const svg = engraved(layout(nastyChart()));
    const segments = [...svg.matchAll(/class="se-beam"/g)].length;
    expect(segments).toBe(7);
  });
});
