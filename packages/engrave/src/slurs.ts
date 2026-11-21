import type { MusicFont } from './font.js';
import { units } from './font.js';
import type { TieEnd } from './ties.js';
import type { SvgElement } from './svg.js';
import { el, num } from './svg.js';

/**
 * Slurs (SIB2-168).
 *
 * A slur is drawn like a tie, the same thin-ended lens, but it differs in three ways that are all
 * about where it goes:
 *
 * - **Side.** On the notehead side, away from the stems: a run of up-stemmed notes is slurred below,
 *   a run of down-stemmed notes above, and a mixed run goes above (the majority of the notes under
 *   the curve decides, a tie going above). The score may override it (`placement`).
 * - **Ends.** On the notehead side it starts and ends just clear of the head (three-quarters of a staff
 *   space off its centre); a note whose stem is on the slur's side takes it at the stem tip instead, so
 *   the curve never strikes through a stem.
 * - **Height.** It rises just enough to clear every note and stem under it, and no more, so a slur
 *   over a quiet scale stays flat and one over a leap arches. It is held below the chord band's
 *   baseline, so it never runs into a chord symbol.
 *
 * Nothing here measures text or asks a browser anything; every number is notehead and stem geometry
 * the engraver already settled (ADR-0015).
 */

/** How far off a notehead's centre a slur starts on the head side. */
const HEAD_OFFSET = units(0.75);
/** How far past a stem tip a slur starts on the stem side. */
const STEM_OFFSET = units(0.35);
/** Clearance over any note's head or stem under the curve. */
const HEAD_CLEARANCE = units(0.5);
const STEM_CLEARANCE = units(0.3);

/** Rise of the curve's control points over its chord: a fraction of the span, within a range. */
const RISE_RATIO = 0.12;
const MIN_RISE = units(0.8);
const MAX_RISE = units(4);
/** How far a half-slur runs past its one note when it crosses a system break. */
const HALF_RUN = units(5);

export type SlurSide = 'above' | 'below';

export interface SlurSpec {
  from: TieEnd | null;
  to: TieEnd | null;
  /** Every note on the system between the two ends (and the ends themselves), for stems and clearance. */
  under: TieEnd[];
  placement: SlurSide | undefined;
  /** Where this system's music begins and ends, for a slur that leaves the system. */
  systemLeft: number;
  systemRight: number;
  /** The y of the chord band's baseline: the curve is kept below it when above the staff. */
  ceiling: number;
}

/** Above or below, from the stems under the curve unless the score chose. */
export function slurSide(spec: Pick<SlurSpec, 'under' | 'placement'>): SlurSide {
  if (spec.placement !== undefined) return spec.placement;
  let up = 0;
  let down = 0;
  for (const end of spec.under) {
    if (end.stem === 'up') up += 1;
    else if (end.stem === 'down') down += 1;
  }
  return up > down ? 'below' : 'above';
}

interface Point {
  x: number;
  y: number;
}

/** Where the slur meets a note: the head side or the stem tip, centred on the head or the stem. */
function endPoint(end: TieEnd, side: SlurSide, rawX: number): Point {
  const sign = side === 'above' ? -1 : 1;
  const stemOnSide = (end.stem === 'up' && side === 'above') || (end.stem === 'down' && side === 'below');
  if (stemOnSide && end.stemTipY !== undefined && end.stemTipY !== null) {
    return { x: end.stemX ?? rawX, y: end.stemTipY + sign * STEM_OFFSET };
  }
  return { x: rawX, y: end.y + sign * HEAD_OFFSET };
}

/** The y a curve on `side` must stay clear of at a note: its head, or its stem tip when on that side. */
function clearanceAt(end: TieEnd, side: SlurSide): number {
  const sign = side === 'above' ? -1 : 1;
  let y = end.y + sign * HEAD_CLEARANCE;
  const stemOnSide = (end.stem === 'up' && side === 'above') || (end.stem === 'down' && side === 'below');
  if (stemOnSide && end.stemTipY !== undefined && end.stemTipY !== null) {
    const tip = end.stemTipY + sign * STEM_CLEARANCE;
    y = side === 'above' ? Math.min(y, tip) : Math.max(y, tip);
  }
  return y;
}

/**
 * The curve, or null when neither end is on this system. Cubic Bezier from `a` to `b` whose control
 * points sit `rise` off the chord; `rise` grows from a small default until every note under it is cleared.
 */
export function slur(font: MusicFont, spec: SlurSpec): SvgElement | null {
  const anchor = spec.from ?? spec.to;
  if (anchor === null) return null;
  const side = slurSide(spec);
  const sign = side === 'above' ? -1 : 1;

  const centre = (end: TieEnd): number => end.x + end.noteheadWidth / 2;
  const a: Point =
    spec.from === null
      ? { x: Math.max(spec.systemLeft, centre(spec.to as TieEnd) - HALF_RUN), y: endPoint(spec.to as TieEnd, side, 0).y }
      : endPoint(spec.from, side, centre(spec.from));
  const b: Point =
    spec.to === null
      ? { x: Math.min(spec.systemRight, centre(spec.from as TieEnd) + HALF_RUN), y: endPoint(spec.from as TieEnd, side, 0).y }
      : endPoint(spec.to, side, centre(spec.to));

  const span = Math.max(b.x - a.x, units(1));
  // A cubic offset at its control points reaches three quarters of that offset at its middle, so the
  // control offset is the wanted midpoint thickness over 0.75 (a tie, drawn thin, does not bother).
  const midpoint = Math.max(font.ink.tieMidpoint, units(0.22));
  const swell = ((midpoint - font.ink.tieEndpoint) / 0.75) * sign;

  const at = (rise: number, t: number): number => {
    // Cubic with both inner control points `rise` off the chord, at a quarter and three quarters.
    const c1 = a.y + sign * rise;
    const c2 = b.y + sign * rise;
    const u = 1 - t;
    return u * u * u * a.y + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * b.y;
  };
  const clears = (rise: number): boolean =>
    spec.under.every((end) => {
      if (end.x <= a.x - 0.5 || end.x >= b.x + 0.5) return true;
      const t = Math.min(Math.max((centre(end) - a.x) / (b.x - a.x || 1), 0), 1);
      const y = at(rise, t);
      const limit = clearanceAt(end, side);
      return side === 'above' ? y <= limit : y >= limit;
    });

  let rise = Math.min(Math.max(span * RISE_RATIO, MIN_RISE), MAX_RISE);
  while (!clears(rise) && rise < MAX_RISE * 2) rise += units(0.25);
  // Above the staff the chord band is waiting: never rise into it.
  if (side === 'above') {
    while (rise > MIN_RISE && at(rise, 0.5) < spec.ceiling) rise -= units(0.25);
  }

  const c1x = a.x + span * 0.25;
  const c2x = a.x + span * 0.75;
  const c1y = a.y + sign * rise;
  const c2y = b.y + sign * rise;
  const d =
    `M${num(a.x)} ${num(a.y)}` +
    `C${num(c1x)} ${num(c1y)} ${num(c2x)} ${num(c2y)} ${num(b.x)} ${num(b.y)}` +
    `C${num(c2x)} ${num(c2y + swell)} ${num(c1x)} ${num(c1y + swell)} ${num(a.x)} ${num(a.y)}` +
    'Z';
  return el('path', { class: 'se-slur', d, fill: '#000000', stroke: 'none' });
}
