import { beamingChart, nastyChart } from '@sibei/fixtures';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { describe, expect, it } from 'vitest';

/**
 * A beamed note must not also draw its own flag.
 *
 * Regression test for a real defect, kept at the level it was found: the whole rendered
 * page, through the path that actually ships. The V1 adapter built its beams *after*
 * drawing the voice, and a note decides at draw time whether to draw a flag by asking
 * whether it belongs to a beam — at that moment it did not, so the flag was already on
 * the page by the time the beam landed on top of it. Every beamed group came out carrying
 * both, which reads as a smear of ink where the beam should be.
 *
 * The engraver cannot reproduce that bug by construction — it settles every beam before
 * it emits any ink — but "cannot by construction" is exactly the kind of claim that stops
 * being true during a refactor, so the assertion stays.
 */

function render(score: Score): string {
  const svg = renderScoreToSvg(score)[0]?.svg;
  if (svg === undefined) throw new Error('nothing rendered');
  return svg;
}

function count(svg: string, pattern: RegExp): number {
  return [...svg.matchAll(pattern)].length;
}

const FLAG = /class="se-glyph se-flag\w+"/g;
const BEAM = /class="se-beam"/g;
const NOTEHEAD = /class="se-glyph se-notehead\w+"/g;

describe('flags on beamed notes', () => {
  /**
   * The two counts are asserted together because neither is worth much alone, and the
   * pair admits only correct behaviour.
   *
   * `beamingChart` is fourteen notes: eleven beamable ones in four groups, one eighth
   * alone on its beat, and two quarters. Flags on beamed notes would make it eleven
   * flags; no beams at all would make it eleven flags too. Only an engraver that beams
   * the groups *and* flags the loner lands on five beams and one flag.
   */
  it('beams the groups, flags the loner, and does not do both to anything', () => {
    const svg = render(beamingChart());
    expect(count(svg, NOTEHEAD)).toBe(14);
    expect(count(svg, BEAM)).toBe(5);
    expect(count(svg, FLAG)).toBe(1);
  });

  it('beams the nasty chart into the groups its rhythms imply', () => {
    // Six groups — the pickup, bar 2, bar 3's triplet, bar 6's sixteenths, bar 13 and
    // bar 18 — and seven beams, because bar 6's sixteenths carry a second one. If beam
    // grouping regresses, this count moves.
    expect(count(render(nastyChart()), BEAM)).toBe(7);
  });
});
