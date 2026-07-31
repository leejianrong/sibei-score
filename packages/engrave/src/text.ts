import type { LayoutText, LayoutTextRole } from '@sibei/layout';
import type { SvgElement } from './svg.js';
import { el, textEl } from './svg.js';

/**
 * Page text: the title block, bar numbers, rehearsal marks and chord symbols.
 *
 * Everything here is placed with `text-anchor` and **never measured**. Centring text by
 * measuring it needs `getBBox`, which only a real browser implements, so a server render
 * would place text differently from the screen — and ADR-0015 requires those cannot
 * drift. `text-anchor` moves the alignment into the SVG, where both agree by
 * construction. `packages/draw/src/text.ts` reached the same conclusion for the other
 * adapter, and it is the reason neither ever asks how wide a string is.
 */

const SERIF = 'Times New Roman, serif';

const ANCHOR = { left: 'start', center: 'middle', right: 'end' } as const;

export type TextAlign = keyof typeof ANCHOR;

export interface TextStyle {
  family: string;
  weight: string;
  style: string;
}

export function styleForRole(role: LayoutTextRole): TextStyle {
  switch (role) {
    case 'title':
      return { family: SERIF, weight: 'bold', style: 'normal' };
    case 'composer':
    case 'style':
      return { family: SERIF, weight: 'normal', style: 'italic' };
  }
}

export interface TextSpec {
  text: string;
  x: number;
  /** Baseline. */
  y: number;
  size: number;
  align: TextAlign;
  family?: string;
  weight?: string;
  style?: string;
  class?: string;
}

export function text(spec: TextSpec): SvgElement {
  return textEl(
    {
      class: spec.class ?? 'se-text',
      x: spec.x,
      y: spec.y,
      'font-family': spec.family ?? SERIF,
      'font-size': `${spec.size}px`,
      'font-weight': spec.weight ?? 'normal',
      'font-style': spec.style ?? 'normal',
      'text-anchor': ANCHOR[spec.align],
      fill: '#000000',
      stroke: 'none',
    },
    [spec.text],
  );
}

export function headerText(item: LayoutText): SvgElement {
  const style = styleForRole(item.role);
  return text({
    text: item.text,
    x: item.x,
    y: item.y,
    size: item.size,
    align: item.align,
    class: `se-${item.role}`,
    ...style,
  });
}

// ---------------------------------------------------------------------------
// Chord symbols
// ---------------------------------------------------------------------------

/**
 * Root at full size, extensions superscripted, a slash bass back at full size. That is
 * the jazz convention and it is what makes `F#m7b5` read correctly rather than as a run
 * of same-size characters.
 *
 * Presentation only: this splits the text, it does not understand it. Parsing chord text
 * into root, quality, extensions, alterations and bass is the `music` package's job
 * (ADR-0012, P8), and V5 replaces the split below with that structure — which is also
 * where `Δ`, `ø` and proper `alt` typography come from.
 */
const ROOT_PATTERN = /^([A-G](?:##|bb|#|b)?)(.*)$/;

/** How far a superscript rises above the baseline, as a fraction of the font size. */
const SUPERSCRIPT_RISE = 0.42;
const SUPERSCRIPT_SCALE = 0.72;

export interface ChordSpec {
  text: string;
  x: number;
  y: number;
  size: number;
  /** Free text — an instruction, or something the recogniser could not read (Q56). */
  plain: boolean;
}

export function chordSymbol(spec: ChordSpec): SvgElement {
  const attrs = {
    class: spec.plain ? 'se-annotation' : 'se-chord',
    x: spec.x,
    y: spec.y,
    'font-family': SERIF,
    'font-size': `${spec.size}px`,
    'font-weight': 'normal',
    'font-style': 'normal',
    // Chord symbols are left-aligned to their note, as V1 settled.
    'text-anchor': 'start',
    fill: '#000000',
    stroke: 'none',
  };

  const match = spec.plain ? null : ROOT_PATTERN.exec(spec.text);
  if (match === null) {
    // `N.C.`, or text the grammar will later flag. Verbatim and unsplit — superscripting
    // half of `solo break` would be worse than leaving it alone.
    return textEl(attrs, [spec.text]);
  }

  const [, root = '', remainder = ''] = match;
  const slash = remainder.lastIndexOf('/');
  const quality = slash === -1 ? remainder : remainder.slice(0, slash);
  const bass = slash === -1 ? '' : remainder.slice(slash + 1);

  const parts: (SvgElement | string)[] = [root];
  if (quality !== '') parts.push(superscript(quality, spec.size));
  // The slash and the bass stay at full size: a superscripted bass note reads as an
  // extension rather than as the chord's foot.
  if (bass !== '') parts.push(`/${bass}`);

  return textEl(attrs, parts);
}

/**
 * A raised run. `dy` and a smaller `font-size` rather than `baseline-shift`, because
 * `baseline-shift` is inconsistently supported by SVG rasterisers and this is not.
 */
function superscript(value: string, size: number): SvgElement {
  return {
    name: 'tspan',
    attrs: {
      'font-size': `${Number((size * SUPERSCRIPT_SCALE).toFixed(3))}px`,
      dy: -Number((size * SUPERSCRIPT_RISE).toFixed(3)),
    },
    children: [],
    text: [value],
  };
}

/** A rehearsal letter, boxed the way a reader expects to find one. */
export function rehearsalMark(value: string, x: number, y: number, size: number): SvgElement[] {
  const padX = size * 0.4;
  const padY = size * 0.28;
  // The box is sized from the font size and the letter count rather than from a
  // measurement, for the same reason nothing else here is measured.
  const width = size * 0.72 * value.length + padX * 2;
  const height = size + padY * 2;

  return [
    el('rect', {
      class: 'se-rehearsalbox',
      x,
      y: y - size - padY,
      width,
      height,
      fill: 'none',
      stroke: '#000000',
      'stroke-width': 1,
    }),
    text({
      text: value,
      x: x + width / 2,
      y,
      size,
      align: 'center',
      weight: 'bold',
      class: 'se-rehearsalmark',
    }),
  ];
}
