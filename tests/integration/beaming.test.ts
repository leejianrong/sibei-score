import { beamingChart, nastyChart } from '@sibei/fixtures';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

/**
 * A beamed note must not also draw its own flag.
 *
 * Regression test for a real defect: the adapter built its beams *after* drawing the
 * voice. A note decides at draw time whether to draw a flag by asking whether it belongs
 * to a beam — at that moment it did not, so the flag was already on the page by the time
 * the beam landed on top of it. Every beamed group came out carrying both, which reads
 * as a smear of ink where the beam should be.
 *
 * The signal: VexFlow draws a notehead inside `g.vf-notehead` and a stem inside
 * `g.vf-stem`, but a flag as a bare `<path>` directly inside the note's own group. On a
 * fixture with no accidentals, no dots and nothing off the staff — which is exactly what
 * `beamingChart` is for — a bare path in a note group can only be a flag.
 */

function parse(svg: string): Document {
  // jsdom needs a real origin or anything touching storage throws.
  return new JSDOM(`<body>${svg}</body>`, { url: 'http://localhost' }).window.document;
}

function render(score: Score): Document {
  const svg = renderScoreToSvg(score)[0]?.svg;
  if (svg === undefined) throw new Error('nothing rendered');
  return parse(svg);
}

function flagsPerNote(document: Document): number[] {
  return [...document.querySelectorAll('g.vf-stavenote')].map(
    (group) =>
      [...group.children].filter((child) => child.tagName.toLowerCase() === 'path').length,
  );
}

describe('flags on beamed notes', () => {
  it('draws no flag on any note in a beamed group', () => {
    const flags = flagsPerNote(render(beamingChart()));
    // Bar 1 is ten notes, all in beamable groups of two or four.
    expect(flags.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 0));
  });

  it('still draws a flag on an eighth with nothing to beam to', () => {
    // The control. Without it, the test above would pass just as happily against a
    // detector that never finds a flag at all.
    const flags = flagsPerNote(render(beamingChart()));
    expect(flags.slice(10).filter((count) => count > 0)).toHaveLength(1);
  });

  it('beams the nasty chart into the groups its rhythms imply', () => {
    const document = render(nastyChart());
    // The pickup, bar 2, bar 3's triplet, bar 6's sixteenths, bar 13 and bar 18.
    // If beam grouping regresses, this count moves.
    expect(document.querySelectorAll('g.vf-beam')).toHaveLength(6);
  });
});
