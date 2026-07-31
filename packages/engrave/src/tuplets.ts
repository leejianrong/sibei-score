import type { MusicFont } from './font.js';
import { units } from './font.js';
import { digits, run, runWidth } from './signatures.js';
import type { StemDirection } from './stems.js';
import type { SvgElement } from './svg.js';
import { el } from './svg.js';

/**
 * Tuplet brackets and their numbers.
 *
 * Two conventions, and the second is the one that is easy to get wrong. The bracket goes
 * on the stem side, above a group of up stems. And **a fully beamed tuplet takes no
 * bracket** — the beam already groups the notes, so a bracket over it is noise. Bar 3's
 * eighth triplet is beamed and gets a bare `3`; bar 10's quarter triplet is not, and gets
 * the bracket.
 *
 * The number is set in SMuFL's `tuplet` digits rather than in text, so it needs no font
 * metrics and matches the face the rest of the page is engraved in.
 */

/** How far the bracket clears the ink it spans. */
const BRACKET_CLEARANCE = units(1.2);

/** The downward hooks at each end of a bracket. */
const BRACKET_HOOK = units(0.8);

/** Air either side of the number, where the bracket breaks for it. */
const NUMBER_GAP = units(0.5);

export interface TupletSpec {
  /** How many notes are written where `normal` would fit. */
  actual: number;
  /** Left and right edges of the group's ink. */
  left: number;
  right: number;
  /** The extreme y the group's ink reaches on the bracket's side. */
  extentY: number;
  direction: StemDirection;
  /** A fully beamed group needs no bracket, only the number. */
  beamed: boolean;
}

export function tuplet(font: MusicFont, spec: TupletSpec): SvgElement[] {
  const away = spec.direction === 'up' ? -1 : 1;
  const y = spec.extentY + away * BRACKET_CLEARANCE;

  const values = digits(spec.actual);
  const numberWidth = runWidth(font, values, 'tuplet');
  const centre = (spec.left + spec.right) / 2;
  // A digit sits on its baseline, so centring it on the bracket line means dropping the
  // baseline by half the glyph's own height — the font's number, not a constant. Bravura
  // and Petaluma differ here by a third of a staff space, and using one for the other
  // pushes the number into the beam.
  const box = font.box(`tuplet${values[0] ?? 0}`);
  const numberY = y - box.top - box.height / 2;
  const elements = run(font, values, 'tuplet', centre - numberWidth / 2, numberY);

  if (spec.beamed) return elements;

  const thickness = font.ink.tupletBracket;
  const breakLeft = centre - numberWidth / 2 - NUMBER_GAP;
  const breakRight = centre + numberWidth / 2 + NUMBER_GAP;

  const rule = (x: number, width: number): SvgElement =>
    el('rect', { class: 'se-tupletbracket', x, y, width: Math.max(width, 0), height: thickness, fill: '#000000' });

  const hook = (x: number): SvgElement =>
    el('rect', {
      class: 'se-tupletbracket',
      x,
      y: away === -1 ? y : y - BRACKET_HOOK + thickness,
      width: thickness,
      height: BRACKET_HOOK,
      fill: '#000000',
    });

  return [
    rule(spec.left, breakLeft - spec.left),
    rule(breakRight, spec.right - breakRight),
    hook(spec.left),
    hook(spec.right - thickness),
    ...elements,
  ];
}
