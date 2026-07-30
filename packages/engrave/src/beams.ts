import { BEAM_PITCH, INK, units } from './bravura.js';
import type { Stem, StemDirection } from './stems.js';
import type { SvgElement } from './svg.js';
import { el, num } from './svg.js';

/**
 * Beams: the hard part, and the risk ADR-0030 named.
 *
 * Four decisions, in order, and none of them is in the font:
 *
 * 1. **Direction** for the whole group, from the note furthest off the middle line.
 *    Handled in `stems.ts`, because a lone note needs the same rule.
 * 2. **Slope.** Two limits, both Gould's. The beam may not slant further than the
 *    interval between the outer notes allows — a third gets half a space, whatever the
 *    noteheads do in between — and it may not exceed a gentle maximum gradient, so a
 *    tight group with a wide leap stays readable rather than becoming a ramp.
 * 3. **Position**, which fixes the length of every stem at once. The beam is placed so
 *    that the note nearest it keeps a standard stem, which makes every other stem in
 *    the group longer rather than shorter. Under that rule no stem can come out short,
 *    so there is no minimum to enforce afterwards.
 * 4. **Which beams, over which notes.** The primary beam spans the group. Each further
 *    beam covers only the runs of consecutive notes that are short enough to need it,
 *    and a note needing one on its own gets a partial beam.
 *
 * Everything is derived from the line, so "every stem terminates on the beam" is true
 * by construction rather than by agreement: `applyBeam` writes the stem ends from it.
 */

export interface BeamMember {
  stem: Stem;
  /** Staff position in half spaces, for the slant limit. */
  position: number;
  /** 1 for an eighth, 2 for a sixteenth. */
  levels: number;
}

/** The beam's outer edge as a line: `y = intercept + slope * x`. */
export interface BeamLine {
  slope: number;
  intercept: number;
  direction: StemDirection;
}

/**
 * How far a beam may slant, in staff spaces, by the interval between the outer notes.
 * Gould's slant table, in the abbreviated form most engravers use: a second barely
 * slants, a third or fourth gets half a space, wider intervals a full space, and
 * nothing exceeds one and a quarter however far the leap.
 */
const SLANT_BY_INTERVAL = [0, 0.25, 0.5, 0.5, 1, 1, 1, 1.25];

/**
 * And a ceiling on the gradient itself, for the case the table cannot see: four
 * sixteenths inside one beat span little x, so even half a space of slant can come out
 * steep. One space of rise to four of run.
 */
export const MAX_BEAM_GRADIENT = 0.25;

export function slantLimit(interval: number): number {
  const index = Math.min(Math.abs(interval), SLANT_BY_INTERVAL.length - 1);
  return units(SLANT_BY_INTERVAL[index] ?? 0);
}

/**
 * Fit the beam to a group. `members` must be in reading order and hold at least two
 * notes; a single note carries a flag, not a beam.
 */
export function beamLine(members: readonly BeamMember[]): BeamLine {
  const first = members[0];
  const last = members[members.length - 1];
  if (first === undefined || last === undefined) throw new Error('a beam needs members');
  const direction = first.stem.direction;

  const run = last.stem.centre - first.stem.centre;
  const limit = slantLimit(last.position - first.position);
  let rise = clamp(last.stem.endY - first.stem.endY, -limit, limit);
  if (run !== 0 && Math.abs(rise / run) > MAX_BEAM_GRADIENT) {
    rise = Math.sign(rise) * MAX_BEAM_GRADIENT * Math.abs(run);
  }
  const slope = run === 0 ? 0 : rise / run;

  // The binding note is the one whose standard-length stem end sits furthest along the
  // stem direction. Anchoring there gives it exactly the standard length and leaves
  // every other stem in the group longer.
  const intercepts = members.map((member) => member.stem.endY - slope * member.stem.centre);
  const intercept =
    direction === 'up' ? Math.min(...intercepts) : Math.max(...intercepts);

  return { slope, intercept, direction };
}

export function beamYAt(line: BeamLine, x: number): number {
  return line.intercept + line.slope * x;
}

/** Move every stem in the group to end on the beam. */
export function applyBeam(line: BeamLine, members: readonly BeamMember[]): void {
  for (const member of members) {
    member.stem.endY = beamYAt(line, member.stem.centre);
  }
}

/** How long a partial beam is: a note needing a beam its neighbours do not. */
export const PARTIAL_BEAM = units(1);

export interface Segment {
  level: number;
  x1: number;
  x2: number;
}

/**
 * The beam rectangles for a group. Level 1 spans everything; each deeper level covers
 * only the runs that need it, with a partial beam where a run is one note long.
 */
export function beamSegments(members: readonly BeamMember[]): Segment[] {
  const first = members[0];
  const last = members[members.length - 1];
  if (first === undefined || last === undefined) return [];

  const segments: Segment[] = [{ level: 1, x1: first.stem.left, x2: last.stem.right }];
  const deepest = Math.max(...members.map((member) => member.levels));

  for (let level = 2; level <= deepest; level += 1) {
    let runStart: number | null = null;
    for (let index = 0; index <= members.length; index += 1) {
      const member = members[index];
      const needs = member !== undefined && member.levels >= level;
      if (needs && runStart === null) runStart = index;
      if (!needs && runStart !== null) {
        segments.push(runSegment(members, runStart, index - 1, level));
        runStart = null;
      }
    }
  }

  return segments;
}

/**
 * A run of one note gets a stub. It points back towards the previous note, which is
 * the convention — a run of one at the start of a group has no "back", so that one
 * points forwards.
 */
function runSegment(
  members: readonly BeamMember[],
  from: number,
  to: number,
  level: number,
): Segment {
  const start = members[from];
  const end = members[to];
  if (start === undefined || end === undefined) throw new Error('bad beam run');
  if (from !== to) return { level, x1: start.stem.left, x2: end.stem.right };
  if (from > 0) return { level, x1: start.stem.left - PARTIAL_BEAM, x2: start.stem.right };
  return { level, x1: start.stem.left, x2: start.stem.right + PARTIAL_BEAM };
}

export function beamElements(line: BeamLine, members: readonly BeamMember[]): SvgElement[] {
  const inward = line.direction === 'up' ? 1 : -1;

  return beamSegments(members).map((segment) => {
    // Each deeper beam steps inward, towards the noteheads.
    const offset = inward * (segment.level - 1) * BEAM_PITCH;
    const y1 = beamYAt(line, segment.x1) + offset;
    const y2 = beamYAt(line, segment.x2) + offset;
    // The outer edge is the top for an upward group, the bottom for a downward one.
    const far = line.direction === 'up' ? INK.beam : -INK.beam;
    return el('polygon', {
      class: 'se-beam',
      points: [
        point(segment.x1, y1),
        point(segment.x2, y2),
        point(segment.x2, y2 + far),
        point(segment.x1, y1 + far),
      ].join(' '),
      fill: '#000000',
    });
  });
}

function point(x: number, y: number): string {
  return `${num(x)},${num(y)}`;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
