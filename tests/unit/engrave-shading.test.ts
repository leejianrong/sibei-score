import {
  BOTTOM_LINE,
  FLAGGED_OBJECT_FILL,
  INVALID_BAR_FILL,
  TOP_LINE,
  engravePage,
  flaggedChordShade,
  flaggedItemShade,
  invalidBarShade,
  num,
  positionY,
  units,
} from '@sibei/engrave';
import { nastyChart, reviewChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { describe, expect, it } from 'vitest';

/**
 * Review shading (V14c, ADR-0013, ADR-0019). Two washes the engraver lays behind the glyphs:
 * a bar wash for a rhythm that does not fill the meter, an object wash for anything the
 * recogniser flagged. This file pins the box geometry of the pure builders, then checks that
 * a real render draws one wash per flag, behind the ink, and none at all for a clean chart.
 *
 * Whether to shade is layout's decision (`bar.metrics.valid`, `LayoutItem.flagged`) and is
 * tested where those are derived; here we only care that the drawing is right (ADR-0014).
 */

const STAVE_Y = 200;

/** The staff-height band both staff-width washes span: the five lines plus a little air. */
function expectedBand(): { y: number; height: number } {
  const y = positionY(TOP_LINE, STAVE_Y) - units(0.6);
  const bottom = positionY(BOTTOM_LINE, STAVE_Y) + units(0.6);
  return { y, height: bottom - y };
}

describe('the shading box builders place a rect from coordinates, never a measurement', () => {
  it('washes a whole bar box for an invalid bar', () => {
    const band = expectedBand();
    const rect = invalidBarShade(120, 300, STAVE_Y);
    expect(rect.name).toBe('rect');
    expect(rect.attrs['x']).toBe(120);
    expect(rect.attrs['width']).toBe(300);
    expect(rect.attrs['y']).toBe(band.y);
    expect(rect.attrs['height']).toBe(band.height);
    expect(rect.attrs['fill']).toBe(INVALID_BAR_FILL);
  });

  it('stripes a flagged note down its own notehead column, padded a little either side', () => {
    const band = expectedBand();
    const pad = units(0.3);
    const rect = flaggedItemShade(200, 12, STAVE_Y);
    expect(rect.attrs['x']).toBe(200 - pad);
    expect(rect.attrs['width']).toBe(12 + pad * 2);
    expect(rect.attrs['y']).toBe(band.y);
    expect(rect.attrs['height']).toBe(band.height);
    expect(rect.attrs['fill']).toBe(FLAGGED_OBJECT_FILL);
  });

  it('sizes a flagged chord wash from the character count and the font size', () => {
    const size = 14;
    const rect = flaggedChordShade(50, 3, 100, size);
    // Estimated, not measured: width grows with the text length; the box straddles the baseline.
    expect(rect.attrs['width']).toBe(size * 0.6 * 3 + size * 0.25 * 2);
    expect(rect.attrs['x']).toBe(50 - size * 0.25);
    expect(rect.attrs['y']).toBe(100 - size);
    expect(rect.attrs['fill']).toBe(FLAGGED_OBJECT_FILL);
  });
});

describe('a rendered page draws one wash per flag, behind the ink', () => {
  const svg = engravePage(layout(reviewChart()), 0).svg;

  const count = (needle: string): number => svg.split(needle).length - 1;

  it('washes the single invalid bar once', () => {
    expect(count('se-invalidbar')).toBe(1);
    expect(svg).toContain(INVALID_BAR_FILL);
  });

  it('washes every flagged object: two notes, a chord and an annotation', () => {
    // Bar 1 flags a note and a chord, bar 2 flags a note (over the invalid-bar wash), bar 3
    // flags an annotation — four in all.
    expect(count('se-flagged')).toBe(4);
    expect(svg).toContain(FLAGGED_OBJECT_FILL);
  });

  it('puts both washes behind the staff lines, so they read as highlights not occlusions', () => {
    // Everything shaded is emitted before the first staff line in the markup, i.e. lower z.
    const firstStaff = svg.indexOf('se-stafflines');
    expect(firstStaff).toBeGreaterThan(-1);
    expect(svg.indexOf('se-invalidbar')).toBeLessThan(firstStaff);
    expect(svg.indexOf('se-flagged')).toBeLessThan(firstStaff);
  });

  it('matches the invalid-bar wash to the layout bar box it covers', () => {
    const bar = layout(reviewChart())
      .pages[0]?.systems.flatMap((system) => system.bars)
      .find((candidate) => candidate.barNumber === 2);
    expect(bar?.metrics.valid).toBe(false);
    // The rect layout drew for that bar carries the bar's own x and width — no second guess.
    const drawn = svg.match(/<rect class="se-invalidbar" x="([^"]+)"[^>]*width="([^"]+)"/);
    expect(drawn?.[1]).toBe(num(bar?.x ?? 0));
    expect(drawn?.[2]).toBe(num(bar?.width ?? 0));
  });
});

describe('a clean chart draws no shading at all', () => {
  it('leaves a fully valid, unflagged chart exactly as it was', () => {
    const svg = engravePage(layout(nastyChart()), 0).svg;
    expect(svg).not.toContain('se-invalidbar');
    expect(svg).not.toContain('se-flagged');
  });
});
