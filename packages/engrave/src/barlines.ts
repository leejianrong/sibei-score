import type { EndBarline, EndingRole, StartBarline } from '@sibei/model';
import type { MusicFont } from './font.js';
import { units } from './font.js';
import { BOTTOM_LINE, TOP_LINE, positionY } from './staff.js';
import type { SvgElement } from './svg.js';
import { el } from './svg.js';
import { text } from './text.js';

/**
 * Barlines, repeat dots and ending brackets.
 *
 * Every one of these is a rectangle or two, and every thickness and gap comes out of
 * `engravingDefaults` — `thinBarlineThickness`, `thickBarlineThickness`,
 * `barlineSeparation`, `repeatBarlineDotSeparation`, `repeatEndingLineThickness`. There
 * is nothing here to tune, which is the whole argument for reading a font's own metrics
 * rather than inventing them (ADR-0030).
 *
 * A barline's x is its **right** edge when it closes a bar and its **left** edge when it
 * opens one, so consecutive bars meet on the line rather than straddling it.
 */

/**
 * A barline that runs through several staves (ADR-0041, `LayoutSystem.staffSpan`): one tall line from the top
 * line of the first staff to the bottom line of the last, with repeat dots still drawn on each staff itself.
 */
export interface BarlineJoin {
  y: number;
  height: number;
  /** The top line of each staff the line joins, for the repeat dots. */
  staveYs: readonly number[];
}

function line(x: number, width: number, staveY: number, kind: string, join?: BarlineJoin): SvgElement {
  return el('rect', {
    class: `se-barline se-barline-${kind}`,
    x,
    y: join === undefined ? positionY(TOP_LINE, staveY) : join.y,
    width,
    height: join === undefined ? positionY(BOTTOM_LINE, staveY) - positionY(TOP_LINE, staveY) : join.height,
    fill: '#000000',
  });
}

/** Repeat dots sit in the two spaces either side of the middle line. */
function repeatDots(font: MusicFont, x: number, staveY: number, join?: BarlineJoin): SvgElement[] {
  return (join?.staveYs ?? [staveY]).flatMap((y) =>
    [3, 5].map((position) => font.element('repeatDot', x, positionY(position, y))),
  );
}

/** The line a system opens with, before its first bar. */
export function openingBarline(font: MusicFont, x: number, staveY: number, join?: BarlineJoin): SvgElement {
  return line(x, font.ink.thinBarline, staveY, 'single', join);
}

/**
 * A bar's closing barline, drawn so that its rightmost ink lands on `x`.
 */
export function endBarline(
  font: MusicFont,
  kind: EndBarline,
  x: number,
  staveY: number,
  join?: BarlineJoin,
): SvgElement[] {
  const { thinBarline, thickBarline, barlineSeparation, repeatDotSeparation } = font.ink;

  switch (kind) {
    case 'single':
      return [line(x - thinBarline, thinBarline, staveY, 'single', join)];

    case 'double': {
      const second = x - thinBarline;
      return [
        line(second - barlineSeparation - thinBarline, thinBarline, staveY, 'double', join),
        line(second, thinBarline, staveY, 'double', join),
      ];
    }

    case 'final': {
      const thick = x - thickBarline;
      return [
        line(thick - barlineSeparation - thinBarline, thinBarline, staveY, 'final', join),
        line(thick, thickBarline, staveY, 'final', join),
      ];
    }

    case 'repeat-end': {
      const thick = x - thickBarline;
      const thin = thick - barlineSeparation - thinBarline;
      const dotX = thin - repeatDotSeparation - font.width('repeatDot');
      return [
        ...repeatDots(font, dotX, staveY, join),
        line(thin, thinBarline, staveY, 'repeat', join),
        line(thick, thickBarline, staveY, 'repeat', join),
      ];
    }
  }
}

/**
 * How much room a bar's opening barline needs.
 *
 * Layout allocates a bar's prefix width for the clef, key and time signature and knows
 * nothing about a repeat sign, so the adapter has to make room for one itself — the same
 * seam gap `prefixWidth` closed for the prefix, one size smaller. Noted in
 * `docs/v1b-engraver-spike.md`.
 */
export function startBarlineWidth(font: MusicFont, kind: StartBarline): number {
  if (kind === 'none') return 0;
  const { thinBarline, thickBarline, barlineSeparation, repeatDotSeparation } = font.ink;
  return (
    thickBarline +
    barlineSeparation +
    thinBarline +
    repeatDotSeparation +
    font.width('repeatDot')
  );
}

/** A bar's opening barline, drawn so that its leftmost ink starts at `x`. */
export function startBarline(
  font: MusicFont,
  kind: StartBarline,
  x: number,
  staveY: number,
  join?: BarlineJoin,
): SvgElement[] {
  if (kind === 'none') return [];

  const { thinBarline, thickBarline, barlineSeparation, repeatDotSeparation } = font.ink;
  const thin = x + thickBarline + barlineSeparation;
  return [
    line(x, thickBarline, staveY, 'repeat', join),
    line(thin, thinBarline, staveY, 'repeat', join),
    ...repeatDots(font, thin + thinBarline + repeatDotSeparation, staveY, join),
  ];
}

// ---------------------------------------------------------------------------
// Endings
// ---------------------------------------------------------------------------

/** How far the hook of an ending bracket drops towards the staff. */
const ENDING_HOOK = units(1.2);

/** Gap between the bracket and the number under it. */
const ENDING_TEXT_INSET = units(0.5);

export interface EndingSpec {
  numbers: number[];
  role: EndingRole;
  /** Left and right edges of the bar the ending covers. */
  x: number;
  right: number;
  /** Baseline the bracket runs along. */
  y: number;
  fontSize: number;
}

/**
 * A first- or second-time bracket: a horizontal rule with a hook down at the ends that
 * close, and the number tucked under the left end.
 */
export function ending(font: MusicFont, spec: EndingSpec): SvgElement[] {
  const thickness = font.ink.endingLine;
  const elements: SvgElement[] = [
    el('rect', {
      class: 'se-ending',
      x: spec.x,
      y: spec.y,
      width: spec.right - spec.x,
      height: thickness,
      fill: '#000000',
    }),
  ];

  const hook = (x: number): SvgElement =>
    el('rect', {
      class: 'se-ending',
      x,
      y: spec.y,
      width: thickness,
      height: ENDING_HOOK,
      fill: '#000000',
    });

  if (spec.role === 'start' || spec.role === 'start-stop') elements.push(hook(spec.x));
  if (spec.role === 'stop' || spec.role === 'start-stop') {
    elements.push(hook(spec.right - thickness));
  }

  if (spec.role === 'start' || spec.role === 'start-stop') {
    elements.push(
      text({
        text: `${spec.numbers.join(', ')}.`,
        x: spec.x + ENDING_TEXT_INSET,
        y: spec.y + ENDING_HOOK,
        size: spec.fontSize,
        align: 'left',
        class: 'se-endingnumber',
      }),
    );
  }

  return elements;
}
