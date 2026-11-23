import type { Id, Score } from '@sibei/model';
import type { Lane } from './lanes.js';
import { BRACE_WIDTH, BRACKET_WIDTH, GROUP_GAP } from './lanes.js';

/**
 * Instrument names at the left of a system (SIB2-286).
 *
 * `meta.showInstrumentNames` turns them on; the full name heads the first system and the part's short name every
 * later one. Room is reserved only for a name that is actually drawn on that system, by narrowing the system from the
 * left, so a chart without the option (or with no name set) lays out exactly as before. No glyph is measured
 * (ADR-0015): the width is the same kind of estimate the rest of layout uses, and the engraver anchors each name at
 * its right edge (`text-anchor: end`), so an estimate that runs short spills into the margin, never onto a staff.
 */

/** The size of a name, in layout units (a staff space is 10). */
export const NAME_SIZE = 15;
/** Clear space between a name's right edge and the brace or bracket (or the staff, with neither). */
export const NAME_GAP = 8;
/** Average advance of a character as a fraction of the size: a serif face, mixed case. */
const NAME_ADVANCE = 0.52;

export interface LayoutSystemName {
  partId: Id;
  text: string;
  size: number;
  /** The right edge of the text (anchored `end`). */
  x: number;
  /** Indices into the system's staves (0 for a single-staff system), inclusive; the name is centred on them. */
  firstStaff: number;
  lastStaff: number;
}

export function estimateNameWidth(text: string): number {
  return Math.ceil(text.length * NAME_SIZE * NAME_ADVANCE);
}

/** The text a part prints on a system: its full name on the first, its short name on the rest. */
function textFor(part: { name: string; shortName?: string }, systemIndex: number): string {
  return (systemIndex === 0 ? part.name : (part.shortName ?? '')).trim();
}

/** How far the braces and bracket reach left of the system's first staff line. */
function groupExtent(lanes: readonly Lane[]): number {
  const partIds = new Set(lanes.map((lane) => lane.part.id));
  const braced = [...partIds].some((id) => lanes.filter((lane) => lane.part.id === id).length > 1);
  const bracketed = partIds.size > 1;
  if (!braced && !bracketed) return 0;
  return GROUP_GAP + (braced ? BRACE_WIDTH + GROUP_GAP : 0) + (bracketed ? BRACKET_WIDTH : 0);
}

/** The width the names of system `systemIndex` take off its left, 0 when none is drawn. */
export function nameIndent(score: Score, lanes: readonly Lane[], systemIndex: number): number {
  if (score.meta.showInstrumentNames !== true) return 0;
  let widest = 0;
  for (const part of score.parts) widest = Math.max(widest, estimateNameWidth(textFor(part, systemIndex)));
  if (widest === 0) return 0;
  return widest + NAME_GAP + groupExtent(lanes);
}

/** The names to draw on system `systemIndex`, whose first staff line starts at `systemX`. */
export function namesFor(score: Score, lanes: readonly Lane[], systemIndex: number, systemX: number): LayoutSystemName[] {
  if (score.meta.showInstrumentNames !== true) return [];
  const names: LayoutSystemName[] = [];
  const x = systemX - groupExtent(lanes) - NAME_GAP;
  for (const part of score.parts) {
    const text = textFor(part, systemIndex);
    if (text === '') continue;
    const mine = lanes.filter((lane) => lane.part.id === part.id).map((lane) => lane.index);
    if (mine.length === 0) continue;
    names.push({ partId: part.id, text, size: NAME_SIZE, x, firstStaff: mine[0]!, lastStaff: mine[mine.length - 1]! });
  }
  return names;
}
