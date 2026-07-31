import { ENGRAVED_ITEM_KINDS, engravePage } from '@sibei/engrave';
import { beamingChart, everyGlyphChart, longFormChart, nastyChart } from '@sibei/fixtures';
import type { LayoutResult, LayoutSystem } from '@sibei/layout';
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

describe('the bands layout reserved', () => {
  /** Every boxed rehearsal letter, as the top and bottom of its rectangle. */
  function rehearsalBoxes(svg: string): { top: number; bottom: number }[] {
    return [
      ...svg.matchAll(/class="se-rehearsalbox" x="[\d.]+" y="([\d.-]+)"[^/]*height="([\d.]+)"/g),
    ].map((match) => ({
      top: Number(match[1]),
      bottom: Number(match[1]) + Number(match[2]),
    }));
  }

  function systemsWithAMark(systems: readonly LayoutSystem[]): LayoutSystem[] {
    return systems.filter((system) =>
      system.bars.some((bar) => bar.items.some((item) => item.kind === 'rehearsalMark')),
    );
  }

  it('puts a rehearsal mark inside its band rather than above the system', () => {
    // Found by looking at page 2 of the long-form chart, which is the first page in the
    // corpus whose first ink is a rehearsal mark: the box hung above the top of the
    // system layout had placed, and so into the page's top margin. On page 1 the same
    // overhang is invisible, because the title block's reserved height swallows it.
    //
    // `rehearsalBand` is what layout reserves above the chord line (ADR-0014); the
    // adapter's job is to draw the box in it, not near it.
    const result = layout(longFormChart());

    for (const page of result.pages) {
      const boxes = rehearsalBoxes(engravePage(result, page.index).svg);
      const marked = systemsWithAMark(page.systems);
      expect(boxes).toHaveLength(marked.length);

      for (const [index, box] of boxes.entries()) {
        const system = marked[index];
        expect(box.top, `page ${page.index + 1}, system ${system?.index}`).toBeGreaterThanOrEqual(
          system?.y ?? 0,
        );
        expect(box.bottom).toBeLessThanOrEqual((system?.y ?? 0) + result.pageSpec.rehearsalBand);
      }
    }
  });

  it('starts a tie arriving from the previous system after the clef and key signature', () => {
    // `prefixWidth` is published so an adapter knows where a bar's *music* starts. The
    // half-tie that arrives from the previous system was reaching back to the system's
    // left edge instead, so it began inside the key signature: visible at bar 33, the
    // first bar of the long-form chart's second page, and at bar 9 of the nasty chart
    // long before that.
    for (const score of [longFormChart(), nastyChart()]) {
      const result = layout(score);

      for (const page of result.pages) {
        const svg = engravePage(result, page.index).svg;
        const starts = [...svg.matchAll(/class="se-tie" d="M([\d.-]+) /g)].map((m) =>
          Number(m[1]),
        );
        // The earliest point on this page at which any bar's music may begin.
        const musicLeft = Math.min(
          ...page.systems.map((s) => (s.bars[0]?.x ?? 0) + (s.bars[0]?.prefixWidth ?? 0)),
        );

        expect(starts.length).toBeGreaterThan(0);
        for (const start of starts) expect(start).toBeGreaterThanOrEqual(musicLeft);
      }
    }
  });

  it('draws no rectangle above the top margin of a page with no title block', () => {
    // Staff lines, stems, beams, ledger lines and the rehearsal box are all rects, so
    // their geometry is exact and needs no measuring to check. A page that is not the
    // first has nothing above its first system, which makes it the page where ink in the
    // margin has nowhere to hide.
    const result = layout(longFormChart());
    const spec = result.pageSpec;

    for (const page of result.pages.slice(1)) {
      const svg = engravePage(result, page.index).svg;
      const tops = [...svg.matchAll(/<rect [^>]*\sy="([\d.-]+)"/g)].map((m) => Number(m[1]));

      expect(tops.length).toBeGreaterThan(0);
      expect(Math.min(...tops), `page ${page.index + 1}`).toBeGreaterThanOrEqual(spec.margin.top);
    }
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
