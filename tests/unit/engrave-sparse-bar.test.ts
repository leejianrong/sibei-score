import { BarBuilder } from '@sibei/fixtures';
import { createIdFactory, dur, makeScore } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { describe, expect, it } from 'vitest';

/**
 * SIB2-165 / SIB2-192: chords sit at their beat over a sparse bar, and a whole-bar rest is centred.
 * The pixels were looked at (`pnpm proof`); here the x positions are pinned.
 */
function chart(build: (b: BarBuilder) => void): string {
  const ids = createIdFactory();
  const bar = new BarBuilder(ids, { number: 1 });
  build(bar);
  const pages = renderScoreToSvg(makeScore({ id: 's', title: 'Sparse', bars: [bar.build()] }));
  return pages.map((page) => page.svg).join('\n');
}

/** The x of the first `<text>` whose content contains the label. */
function textX(svg: string, label: string): number {
  for (const m of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    if ((m[2] ?? '').includes(label)) return Number(/\bx="([0-9.-]+)"/.exec(m[1] ?? '')?.[1]);
  }
  throw new Error(`no text containing ${label}`);
}

describe('chords over a sparse bar', () => {
  it('draws chords on beats 1 and 3 of a whole rest apart, not on top of each other', () => {
    const svg = chart((b) => b.rest(dur(1)).chord(1, 'Cmaj7', 480).chord(3, 'G7', 480));
    expect(textX(svg, 'G') - textX(svg, 'C')).toBeGreaterThan(30);
  });

  it('puts the chord on beat 3 of a half note after the one on beat 1', () => {
    const svg = chart((b) => b.note('C5', dur(2)).note('D5', dur(2)).chord(1, 'Dm7', 480).chord(2, 'G7', 480));
    expect(textX(svg, 'G') - textX(svg, 'D')).toBeGreaterThan(30);
  });
});
