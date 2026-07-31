import type { MusicFont } from './font.js';
import { units } from './font.js';
import type { StemDirection } from './stems.js';
import type { SvgElement } from './svg.js';
import { el, num } from './svg.js';

/**
 * Ties.
 *
 * A tie is a lens: thin where it meets a notehead, thicker in the middle. SMuFL gives
 * both numbers — `tieEndpointThickness` and `tieMidpointThickness` — so the shape is the
 * font's rather than ours. It is drawn as one filled path: out along the upper edge,
 * back along the lower, with the return curve's control points pushed out by the extra
 * midpoint thickness. That is what makes the ends taper rather than the whole curve being
 * a uniform stroke.
 *
 * A tie arcs **away from the stems**, so a group of down-stemmed notes gets a tie above
 * the noteheads. It leaves the notehead at its side rather than its centre, so it reads
 * as joining two notes rather than striking through them.
 */

/** How far a tie bulges, as a fraction of its span, and the range that is allowed. */
const BULGE_RATIO = 0.16;
const MIN_BULGE = units(0.6);
const MAX_BULGE = units(1.6);

/** Clearance between a notehead's edge and where the tie starts. */
const NOTE_CLEARANCE = units(0.2);

/** How far a tie continues past the last note when it crosses a system break. */
const HALF_TIE_RUN = units(3);

export interface TieEnd {
  /** Left edge of the notehead. */
  x: number;
  noteheadWidth: number;
  /** Centre of the notehead, vertically. */
  y: number;
  stem: StemDirection | null;
}

export interface TieSpec {
  from: TieEnd | null;
  to: TieEnd | null;
  /** Where this system's music begins and ends, for a tie that leaves the system. */
  systemLeft: number;
  systemRight: number;
}

/**
 * The curve, or null when neither endpoint is on this system — which cannot happen for a
 * tie layout produced, but is cheaper to handle than to prove impossible.
 */
export function tie(font: MusicFont, spec: TieSpec): SvgElement | null {
  const anchor = spec.from ?? spec.to;
  if (anchor === null) return null;

  // Away from the stems. Both ends agree in a single voice; if they disagree across a
  // system break, the note that starts the tie decides.
  const up = (anchor.stem ?? 'down') === 'down';
  const direction = up ? -1 : 1;

  const startX =
    spec.from === null
      ? Math.max(spec.systemLeft, (spec.to?.x ?? 0) - HALF_TIE_RUN)
      : spec.from.x + spec.from.noteheadWidth + NOTE_CLEARANCE;
  const endX =
    spec.to === null
      ? Math.min(spec.systemRight, (spec.from?.x ?? 0) + (spec.from?.noteheadWidth ?? 0) + HALF_TIE_RUN)
      : spec.to.x - NOTE_CLEARANCE;

  const startY = (spec.from ?? spec.to)?.y ?? 0;
  const endY = (spec.to ?? spec.from)?.y ?? 0;
  const span = Math.max(endX - startX, units(0.5));
  const bulge = clamp(span * BULGE_RATIO, MIN_BULGE, MAX_BULGE) * direction;

  const c1x = startX + span * 0.25;
  const c2x = startX + span * 0.75;
  const c1y = startY + bulge;
  const c2y = endY + bulge;
  // The return curve is pushed further out, so the shape is thin at both ends.
  const swell = (font.ink.tieMidpoint - font.ink.tieEndpoint) * direction;

  const d =
    `M${num(startX)} ${num(startY)}` +
    `C${num(c1x)} ${num(c1y)} ${num(c2x)} ${num(c2y)} ${num(endX)} ${num(endY)}` +
    `C${num(c2x)} ${num(c2y + swell)} ${num(c1x)} ${num(c1y + swell)} ${num(startX)} ${num(startY)}` +
    'Z';

  return el('path', { class: 'se-tie', d, fill: '#000000', stroke: 'none' });
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
