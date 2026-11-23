import type { LayoutStaffGroup } from '@sibei/layout';
import type { SvgElement } from './svg.js';
import { el, num } from './svg.js';

/**
 * The braces and brackets that join staves at the head of a system (ADR-0041, slice 4).
 *
 * Layout owns where they go: each group is a box, `x` its left edge, `width` and `y`/`height` the run from the first
 * staff's top line to the last staff's bottom line (`LayoutStaffGroup`). The shapes are ours, filled paths inside that
 * box, because a brace has to stretch to any height, which a glyph does only by being scaled (and Bravura's brace glyphs
 * are not in the vendored slice for that reason).
 *
 * **Brace** (a piano's two staves): a curly brace, its two arms hooking in to the staves at the top and bottom, the
 * point of the cusp facing left at the middle, thickest a quarter of the way down each half and tapering to a point at
 * both ends. **Bracket** (several parts): a thick vertical rule, as thick as a final barline's thick line, with a small
 * serif curling in toward the staves at each end, as Sibelius and engraved scores draw it.
 */

export function brace(group: LayoutStaffGroup): SvgElement {
  const { x, width: w, y, height: h } = group;
  const right = x + w;
  const mid = y + h / 2;

  // One half, from its tip at the staff end down the outer (left) edge to the cusp and back up the inner edge; the arm
  // sweeps in from the tip, runs vertically a quarter of the way down, then bends to the cusp at the middle. `sign`
  // flips it for the bottom half. The stroke is thickest on the vertical run (0.45 of the width) and a point at both ends.
  const half = (edge: number, sign: 1 | -1): string => {
    const at = (fraction: number): number => edge + sign * h * fraction;
    const dy = sign * h;
    const outer =
      `M${num(right)} ${num(edge)}` +
      `C${num(x + w * 0.55)} ${num(edge + dy * 0.03)} ${num(x + w * 0.22)} ${num(at(0.1))} ${num(x + w * 0.22)} ${num(at(0.25))}` +
      `C${num(x + w * 0.22)} ${num(at(0.39))} ${num(x)} ${num(mid - dy * 0.08)} ${num(x)} ${num(mid)}`;
    const inner =
      `C${num(x + w * 0.5)} ${num(mid - dy * 0.06)} ${num(x + w * 0.68)} ${num(at(0.39))} ${num(x + w * 0.68)} ${num(at(0.25))}` +
      `C${num(x + w * 0.68)} ${num(at(0.13))} ${num(x + w * 0.5)} ${num(at(0.06))} ${num(right)} ${num(edge)}Z`;
    return outer + inner;
  };

  return el('path', {
    class: 'se-brace',
    d: half(y, 1) + half(y + h, -1),
    fill: '#000000',
    stroke: 'none',
  });
}

export function bracket(group: LayoutStaffGroup): SvgElement {
  const { x, width: w, y, height: h } = group;
  const serif = w * 1.1;
  // The rule, and a serif at each end: a thick tapering curl from the rule's outer edge in toward the staves.
  const top =
    `M${num(x)} ${num(y)}` +
    `C${num(x + w * 0.6)} ${num(y - w * 0.15)} ${num(x + w + serif * 0.5)} ${num(y - w * 0.55)} ${num(x + w + serif)} ${num(y - w * 0.95)}` +
    `C${num(x + w + serif * 0.4)} ${num(y - w * 0.3)} ${num(x + w * 1.2)} ${num(y + w * 0.1)} ${num(x + w)} ${num(y + w * 0.5)}Z`;
  const bottom =
    `M${num(x)} ${num(y + h)}` +
    `C${num(x + w * 0.6)} ${num(y + h + w * 0.15)} ${num(x + w + serif * 0.5)} ${num(y + h + w * 0.55)} ${num(x + w + serif)} ${num(y + h + w * 0.95)}` +
    `C${num(x + w + serif * 0.4)} ${num(y + h + w * 0.3)} ${num(x + w * 1.2)} ${num(y + h - w * 0.1)} ${num(x + w)} ${num(y + h - w * 0.5)}Z`;
  return el('path', {
    class: 'se-bracket',
    d: `M${num(x)} ${num(y)}H${num(x + w)}V${num(y + h)}H${num(x)}Z${top}${bottom}`,
    fill: '#000000',
    stroke: 'none',
  });
}

/** Every group of a system, brace and bracket alike. */
export function staffGroups(groups: readonly LayoutStaffGroup[]): SvgElement[] {
  return groups.map((group) => (group.kind === 'brace' ? brace(group) : bracket(group)));
}
