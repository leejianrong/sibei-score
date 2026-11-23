import { FIXTURE_REGISTRY, crowdedChordsChart, denseSpacingChart } from '@sibei/fixtures';
import { chordGlyphText } from '@sibei/engrave';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { describe, expect, it } from 'vitest';

/**
 * SIB2-153: text in the chord row must not overlap. Measured on the finished SVG, the way a reader
 * sees it: every `se-chord` / `se-annotation` label on one baseline (one system) is a box
 * `[x, x + advance * glyphs]`, and no two boxes on a baseline may intersect. The advance is the same
 * estimate the engraver spaces with (never a measured width, ADR-0015), and `chordGlyphText` counts
 * the glyphs actually drawn (`Δ`, not `maj`), so a raised extension is not over-counted.
 */

const ADVANCE_EM = 0.6;

interface Label {
  text: string;
  left: number;
  right: number;
  y: number;
}

function labels(svg: string): Label[] {
  const out: Label[] = [];
  for (const m of svg.matchAll(/<text\b([^>]*class="se-(?:chord|annotation)"[^>]*)>([\s\S]*?)<\/text>/g)) {
    const attrs = m[1] ?? '';
    const x = Number(/\bx="([0-9.-]+)"/.exec(attrs)?.[1]);
    const y = Number(/\by="([0-9.-]+)"/.exec(attrs)?.[1]);
    const size = Number(/font-size="([0-9.]+)px"/.exec(attrs)?.[1]);
    const text = (m[2] ?? '').replace(/<[^>]*>/g, '');
    const plain = attrs.includes('se-annotation');
    const glyphs = plain ? text.length : chordGlyphText(text.replace(/&[a-z#0-9]+;/g, '?')).length;
    out.push({ text, left: x, right: x + size * ADVANCE_EM * Math.max(glyphs, text.length * 0.8), y });
  }
  return out;
}

/** Pairs of labels on one baseline whose boxes cross, by at least a pixel. */
export function overlaps(svg: string): string[] {
  const found: string[] = [];
  const all = labels(svg);
  for (const [i, a] of all.entries()) {
    for (const b of all.slice(i + 1)) {
      if (Math.abs(a.y - b.y) > 1) continue;
      if (a.left < b.right - 1 && b.left < a.right - 1) found.push(`${a.text} @${a.left} / ${b.text} @${b.left}`);
    }
  }
  return found;
}

function render(score: Score): string {
  return renderScoreToSvg(score)
    .map((page) => page.svg)
    .join('\n');
}

describe('chord labels never overlap', () => {
  for (const [name, build] of Object.entries(FIXTURE_REGISTRY)) {
    it(`in the ${name} fixture`, () => {
      // Page by page: two pages' systems can share a baseline and an x, and are not on one sheet (SIB2-227).
      expect(renderScoreToSvg(build()).flatMap((page) => overlaps(page.svg))).toEqual([]);
    });
  }

  it('in a chart with a chord on every beat', () => {
    expect(overlaps(render(crowdedChordsChart()))).toEqual([]);
  });
});

describe('ledger lines of neighbouring notes', () => {
  it('leave a visible gap rather than running into one line', () => {
    const svg = render(denseSpacingChart());
    const lines = [...svg.matchAll(/<rect class="se-ledgerline" x="([0-9.]+)" y="([0-9.]+)" width="([0-9.]+)"/g)].map(
      (m) => ({ x: Number(m[1]), y: Number(m[2]), right: Number(m[1]) + Number(m[3]) }),
    );
    expect(lines.length).toBeGreaterThan(8);
    for (const [i, a] of lines.entries()) {
      for (const b of lines.slice(i + 1)) {
        if (Math.abs(a.y - b.y) > 0.01) continue;
        const gap = Math.max(a.x, b.x) - Math.min(a.right, b.right);
        expect(gap, `ledger lines at ${a.x} and ${b.x}`).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

describe('a dense bar takes the room its glyphs need', () => {
  it('is drawn wider than the light bars beside it, and every note stays inside it', () => {
    const svg = render(denseSpacingChart());
    const bars = [...svg.matchAll(/<rect class="se-barline[^"]*" x="([0-9.]+)" y="176"/g)].map((m) => Number(m[1]));
    const widths = bars.slice(1, 5).map((x, i) => x - (bars[i] ?? 0));
    expect(widths[0]).toBeGreaterThan(Math.max(...widths.slice(1)) * 1.5);
    // The grid-only share (a quarter of the line) would have run bar 1's sixteenths over bar 2.
    const heads = [...svg.matchAll(/<path class="se-glyph se-notehead\w+" transform="translate\(([0-9.]+),([0-9.]+)\)/g)]
      .filter((m) => Number(m[2]) < 230)
      .map((m) => Number(m[1]));
    // All twelve of bar 1's noteheads sit inside it.
    const inBar1 = heads.filter((x) => x > (bars[0] ?? 0) && x < (bars[1] ?? 0));
    expect(inBar1).toHaveLength(12);
  });
});
