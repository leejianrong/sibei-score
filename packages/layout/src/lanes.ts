import type { BarItem, BarView, Id, Part, Score, Staff, StaffType, TimeSignature } from '@sibei/model';
import { TICKS_PER_QUARTER, allStaves, barCapacity, barView, itemTicks, keyFifths } from '@sibei/model';
import { noteAndRestItems, tupletBracketItems } from './bar-items.js';
import type { Clef, LayoutBarItem, LayoutTie } from './items.js';
import type { LayoutBar } from './layout.js';
import type { PageSpec } from './page.js';
import type { SystemVertical } from './vertical.js';
import { staffInk } from './vertical.js';
import type { AllocatedBar, BarPrefix, BarSizing } from './widths.js';
import { estimateBarWidth, rigidBarWidth } from './widths.js';

/**
 * Staves and voices on one system (ADR-0041 section 5, SIB2-227): what a system carries beyond the lead-sheet's single
 * staff, and the arithmetic that lines it up.
 *
 * The contract (also in `agent_docs/architecture.md`):
 *
 * - `LayoutSystem.bars` is, as ever, the **first staff's first voice** with the chord row, marks and bar numbers.
 *   `LayoutSystem.staves` is additive: present only when the score has more than one staff or voice. `staves[0]`'s
 *   first voice shares its item arrays with `system.bars`, so nothing is built twice.
 * - Every note and rest on the system carries an `x`, and **every item with the same onset in a bar, on any staff or
 *   voice, has the same x** (`LayoutBar.alignment.columns` lists the columns). The engraver places by it instead of
 *   spacing each staff on its own.
 * - A bar is as wide as its **widest staff** wants (`BarSizing`), floored by the union of every staff's rigid width.
 * - Staves stack down the system. The chord and text row sits above the **top** staff only; between staves the gap is
 *   a fixed minimum or the ink the two staves reach into it, whichever is more.
 * - `groups` are the braces (one part's staves, a piano) and the bracket (several parts); `staffSpan` is the vertical
 *   extent every barline runs when it joins the staves. Layout emits the boxes; drawing them is the engraver's.
 *
 * No glyph is measured here (ADR-0015); every number is the same kind of estimate `widths.ts` already uses.
 */

/** Minimum clear space between the bottom line of one staff and the top line of the next: six staff spaces. */
export const STAFF_GAP = 60;
/** Extra room between two different parts (instruments), over the gap between a part's own staves. */
export const PART_GAP = 10;
/** Air kept between the ink one staff reaches down and the ink the next reaches up. */
export const INK_CLEARANCE = 12;
/** Where a brace sits: its right edge this far left of the system, and its width. */
export const BRACE_WIDTH = 10;
export const BRACKET_WIDTH = 5;
const GROUP_GAP = 6;
/** The padding left and right of a bar's first and last column. */
export const ALIGN_LEFT_PAD = 10;
export const ALIGN_RIGHT_PAD = 10;
/** A column's rigid share of a bar, and how much more each doubling of its rhythmic distance buys. */
const COLUMN_BASE = 19;
const COLUMN_STRETCH = 12;

export type StemDirection = 'up' | 'down' | 'auto';

export interface LayoutVoice {
  /** 1-based, as the model's `Voice.index`. */
  index: number;
  /** `up`/`down` for the first/second voice of a staff that has two or more; `auto` for a staff's only voice. */
  stems: StemDirection;
  items: LayoutBarItem[];
}

export interface LayoutStaffBar {
  barId: Id;
  /** Which of the clef, key and time signature this staff draws at the head of this bar. */
  prefix: BarPrefix;
  voices: LayoutVoice[];
}

export interface LayoutStaff {
  /** Position in the system, top to bottom. */
  index: number;
  staffId: Id;
  partId: Id;
  type: StaffType;
  clef: Clef;
  /** Units from the top staff line of the system's top staff to this staff's top line. 0 for the top staff. */
  staveOffset: number;
  /** The y of this staff's top line (the system's `staveY` for the top staff). */
  staveY: number;
  /** Five lines, four spaces. */
  height: number;
  /** The ink this staff's notes reach above and below its lines on this system, for ledger-line room. */
  inkAbove: number;
  inkBelow: number;
  bars: LayoutStaffBar[];
  /** Ties between this staff's notes, any voice, on this system. */
  ties: LayoutTie[];
}

export type StaffGroupKind = 'brace' | 'bracket';

export interface LayoutStaffGroup {
  kind: StaffGroupKind;
  /** The part a brace belongs to; null for the bracket across parts. */
  partId: Id | null;
  /** Indices into `LayoutSystem.staves`, inclusive. */
  firstStaff: number;
  lastStaff: number;
  /** The glyph's box: its left edge, its width, and the top and height it spans (top line of the first staff to the bottom line of the last). */
  x: number;
  width: number;
  y: number;
  height: number;
}

/** The vertical run a barline makes when it joins the staves, and the system's left edge line. */
export interface LayoutStaffSpan {
  firstStaff: number;
  lastStaff: number;
  y: number;
  height: number;
}

export interface LayoutColumn {
  /** Ticks from the start of the bar. */
  onset: number;
  x: number;
}

/** One bar's shared horizontal spacing: where its music runs from and to, and the x of each onset on any staff. */
export interface LayoutAlignment {
  left: number;
  right: number;
  columns: LayoutColumn[];
}

/** What a multi-staff system adds to a `LayoutSystem`. */
export interface LayoutLanes {
  staves: LayoutStaff[];
  groups: LayoutStaffGroup[];
  staffSpan: LayoutStaffSpan;
}

export interface Lane {
  staff: Staff;
  part: Part;
  index: number;
}

/** Every staff in system order, with its part. */
export function lanesOf(score: Score): Lane[] {
  const lanes: Lane[] = [];
  for (const part of score.parts) {
    for (const staff of part.staves) lanes.push({ staff, part, index: lanes.length });
  }
  return lanes;
}

/**
 * Whether a score needs the multi-staff path: more than one staff, or any staff-bar holding more than one voice with
 * music in it. A single-staff single-voice chart takes none of this and lays out exactly as it always has.
 */
export function isMultiLane(score: Score): boolean {
  const staves = allStaves(score);
  if (staves.length > 1) return true;
  return staves.some((staff) => staff.bars.some((bar) => bar.voices.filter((voice) => voice.items.length > 0).length > 1));
}

export interface VoiceView {
  index: number;
  view: BarView;
}

/** The voices of one staff in one bar, voice 1 first; an absent staff-bar is one empty voice. */
export function voiceViewsOf(score: Score, staff: Staff, bar: BarView): VoiceView[] {
  const staffBar = staff.bars.find((candidate) => candidate.barId === bar.id);
  const indices = [...(staffBar?.voices.map((voice) => voice.index) ?? [])].sort((a, b) => a - b);
  if (indices.length === 0) indices.push(1);
  return indices.map((index) => ({ index, view: barView(score, bar, { staff: staff.id, voice: index }) }));
}

const NO_PREFIX: BarPrefix = { clef: false, keySignature: false, timeSignature: false };

/** The items of every voice on a staff, merged by onset: the widest item at each onset stands for the column. */
function unionView(score: Score, base: BarView, views: readonly BarView[]): BarView {
  const byOnset = new Map<number, { item: BarItem; weight: number }>();
  for (const view of views) {
    for (const item of view.items) {
      const weight = estimateBarWidth(score, { ...base, items: [item], tuplets: [], chords: [], annotations: [] }, NO_PREFIX);
      const held = byOnset.get(item.onset);
      if (held === undefined || weight > held.weight) byOnset.set(item.onset, { item, weight });
    }
  }
  const items = [...byOnset.values()].map((entry) => entry.item).sort((a, b) => a.onset - b.onset);
  return { ...base, items, tuplets: [] };
}

/**
 * How a multi-staff score sizes its bars: the weight by the widest staff, the floor by every staff's union (simultaneous
 * notes share a column, so the floor is the columns' width, not any one staff's).
 */
export function sizingFor(score: Score, lanes: readonly Lane[]): BarSizing {
  const viewsOf = (bar: BarView): BarView[][] => lanes.map((lane) => voiceViewsOf(score, lane.staff, bar).map((voice) => voice.view));
  return {
    estimate: (bar) => {
      let widest = bar;
      let most = -1;
      for (const views of viewsOf(bar)) {
        const candidate = unionView(score, bar, views);
        const width = estimateBarWidth(score, candidate, NO_PREFIX);
        if (width > most) {
          most = width;
          widest = candidate;
        }
      }
      return widest;
    },
    rigid: (bar) => unionView(score, bar, viewsOf(bar).flat()),
  };
}

/** What `meta.layout: 'score'` fits lines by: a bar's rigid width over every staff, never narrower than the grid's minimum. */
export function fitFor(score: Score, lanes: readonly Lane[], spec: PageSpec, isFirstBar: (bar: BarView) => boolean) {
  const sizing = sizingFor(score, lanes);
  return {
    available: spec.width - spec.margin.left - spec.margin.right,
    barWidth: (bar: BarView, headsSystem: boolean): number => {
      const prefix: BarPrefix = {
        clef: headsSystem,
        keySignature: headsSystem,
        // The time signature is printed once, on the score's first bar (ADR-0021).
        timeSignature: headsSystem && isFirstBar(bar),
      };
      return Math.max(spec.minBarWidth, rigidBarWidth(score, sizing.rigid(bar), prefix));
    },
  };
}

// ---------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------

/**
 * Where each onset of a bar sits, shared by every staff and voice. Spacing is proportional to rhythmic distance but
 * damped (a logarithm), the usual engraver's compromise, with a rigid floor per column so a run of short notes does not
 * collapse. Deterministic: a pure function of the onsets and the box.
 */
export function alignBar(
  views: readonly BarView[],
  box: { x: number; width: number; prefixWidth: number; isPickup: boolean },
  time: TimeSignature,
): LayoutAlignment {
  const left = box.x + box.prefixWidth + ALIGN_LEFT_PAD;
  const right = Math.max(left, box.x + box.width - ALIGN_RIGHT_PAD);

  const onsets = new Set<number>();
  let contentEnd = 0;
  for (const view of views) {
    for (const item of view.items) {
      onsets.add(item.onset);
      contentEnd = Math.max(contentEnd, item.onset + itemTicks(item, view));
    }
  }
  const sorted = [...onsets].sort((a, b) => a - b);
  if (sorted.length === 0) return { left, right, columns: [] };

  // A pickup is as long as its notes; any other bar is at least a full measure, so a lone half note leaves room.
  const end = box.isPickup ? contentEnd : Math.max(contentEnd, barCapacity(time));
  const sixteenth = TICKS_PER_QUARTER / 4;
  const weights = sorted.map((onset, index) => {
    const gap = Math.max(0, (sorted[index + 1] ?? end) - onset);
    return COLUMN_BASE + COLUMN_STRETCH * Math.log2(1 + gap / sixteenth);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);

  let cumulative = 0;
  const columns = sorted.map((onset, index): LayoutColumn => {
    const x = left + (cumulative / total) * (right - left);
    cumulative += weights[index] ?? 0;
    return { onset, x };
  });
  return { left, right, columns };
}

/** The x of any onset in a bar: a column's own, or interpolated between the columns around it (a chord off the notes). */
export function xAtOnset(alignment: LayoutAlignment, onset: number, end: number): number {
  const { columns } = alignment;
  let previous = -1;
  for (const [index, column] of columns.entries()) {
    if (column.onset <= onset) previous = index;
  }
  if (previous === -1) return alignment.left;
  const from = columns[previous]!;
  if (from.onset === onset) return from.x;
  const next = columns[previous + 1];
  const toOnset = next === undefined ? Math.max(end, onset) : next.onset;
  const toX = next === undefined ? alignment.right : next.x;
  return toOnset === from.onset ? from.x : from.x + ((onset - from.onset) / (toOnset - from.onset)) * (toX - from.x);
}

// ---------------------------------------------------------------------------
// Building the staves of one system
// ---------------------------------------------------------------------------

export interface BuildLanesInput {
  score: Score;
  spec: PageSpec;
  lanes: readonly Lane[];
  allocated: readonly AllocatedBar[];
  /** The top staff's first voice, as the lead-sheet path builds it; its item arrays are shared, not copied. */
  topBars: readonly LayoutBar[];
  shifts: Map<Id, 'up' | 'down'>;
  /** The top staff's vertical as `systemVertical` computed it, over every voice of that staff. */
  vertical: SystemVertical;
  systemX: number;
  /** Per staff id, the ties of that staff's notes by system index. */
  tiesByStaff: Map<Id, Map<number, LayoutTie[]>>;
  systemIndex: number;
}

export interface BuiltLanes extends LayoutLanes {
  belowStaff: number;
  height: number;
  alignments: LayoutAlignment[];
}

export function buildLanes(input: BuildLanesInput): BuiltLanes {
  const { score, spec, lanes, allocated, topBars, vertical } = input;
  const time = score.meta.time;

  // Every voice of every staff, per allocated bar.
  const viewsByLane = lanes.map((lane) => allocated.map((entry) => voiceViewsOf(score, lane.staff, entry.bar)));

  // Align once per bar, over every staff and voice.
  const alignments = allocated.map((entry, barIndex) =>
    alignBar(
      viewsByLane.flatMap((perBar) => (perBar[barIndex] ?? []).map((voice) => voice.view)),
      entry,
      time,
    ),
  );

  const staves = lanes.map((lane, laneIndex): LayoutStaff => {
    const perBar = viewsByLane[laneIndex] ?? [];
    const ink = staffInk(
      perBar.flatMap((voices) => voices.map((voice) => voice.view)),
      input.shifts,
      lane.staff.clef,
    );
    const bars = allocated.map((entry, barIndex): LayoutStaffBar => {
      const voices = perBar[barIndex] ?? [];
      const twoOrMore = voices.length > 1;
      return {
        barId: entry.bar.id,
        prefix: staffPrefix(lane.staff.type, entry.prefix),
        voices: voices.map((voice, voiceIndex): LayoutVoice => {
          const stems: StemDirection = twoOrMore ? (voice.index % 2 === 1 ? 'up' : 'down') : 'auto';
          // The top staff's first voice is the lead-sheet bar's own item list.
          const shared = laneIndex === 0 && voiceIndex === 0 ? topBars[barIndex]?.items : undefined;
          const items = shared ?? laneItems(score, lane.staff, entry, voice, voiceIndex === 0, input.shifts);
          return { index: voice.index, stems, items };
        }),
      };
    });
    return {
      index: laneIndex,
      staffId: lane.staff.id,
      partId: lane.part.id,
      type: lane.staff.type,
      clef: lane.staff.clef,
      staveOffset: 0,
      staveY: 0,
      height: spec.staffHeight,
      inkAbove: ink.inkAbove,
      inkBelow: laneIndex === 0 ? vertical.belowStaff : ink.inkBelow,
      bars,
      ties: input.tiesByStaff.get(lane.staff.id)?.get(input.systemIndex) ?? [],
    };
  });

  // Stack the staves: the top one sits where `systemVertical` put it, each next one below the last staff's lowest ink.
  for (let index = 1; index < staves.length; index += 1) {
    const above = staves[index - 1]!;
    const staff = staves[index]!;
    const sameParts = lanes[index - 1]?.part.id === lanes[index]?.part.id;
    const gap = Math.max(STAFF_GAP + (sameParts ? 0 : PART_GAP), above.inkBelow + staff.inkAbove + INK_CLEARANCE);
    staff.staveOffset = above.staveOffset + spec.staffHeight + gap;
  }
  const last = staves[staves.length - 1]!;
  const belowStaff = staves.length === 1 ? vertical.belowStaff : Math.max(spec.belowStaff, last.inkBelow);
  const height = vertical.aboveStaff + last.staveOffset + spec.staffHeight + belowStaff;

  // Align every note, rest and chord on its bar's column.
  allocated.forEach((entry, barIndex) => {
    const alignment = alignments[barIndex];
    if (alignment === undefined) return;
    const end = alignmentEnd(viewsByLane, barIndex, entry.isPickup, time);
    for (const staff of staves) {
      for (const voice of staff.bars[barIndex]?.voices ?? []) {
        for (const item of voice.items) {
          if (item.kind === 'note' || item.kind === 'rest' || item.kind === 'chordSymbol' || item.kind === 'annotation') {
            item.x = xAtOnset(alignment, item.onset, end);
          }
        }
      }
    }
  });

  const built: BuiltLanes = {
    staves,
    groups: groupsOf(lanes, staves, input.systemX),
    staffSpan: { firstStaff: 0, lastStaff: staves.length - 1, y: 0, height: 0 },
    belowStaff,
    height,
    alignments,
  };
  placeLanes(built, 0, spec);
  return built;
}

function alignmentEnd(
  viewsByLane: readonly (readonly (readonly VoiceView[])[])[],
  barIndex: number,
  isPickup: boolean,
  time: TimeSignature,
): number {
  let contentEnd = 0;
  for (const perBar of viewsByLane) {
    for (const voice of perBar[barIndex] ?? []) {
      for (const item of voice.view.items) contentEnd = Math.max(contentEnd, item.onset + itemTicks(item, voice.view));
    }
  }
  return isPickup ? contentEnd : Math.max(contentEnd, barCapacity(time));
}

/** A percussion or tab staff has no key signature; every staff draws a clef (a neutral one, a TAB marker) and the meter. */
function staffPrefix(type: StaffType, prefix: BarPrefix): BarPrefix {
  return type === 'standard' ? prefix : { ...prefix, keySignature: false };
}

/** One voice's items on a staff that is not the top one's first voice: the head of the bar for voice 1, only music after. */
function laneItems(
  score: Score,
  staff: Staff,
  entry: AllocatedBar,
  voice: VoiceView,
  first: boolean,
  shifts: Map<Id, 'up' | 'down'>,
): LayoutBarItem[] {
  const items: LayoutBarItem[] = [];
  const bar = voice.view;
  if (first) {
    const prefix = staffPrefix(staff.type, entry.prefix);
    if (prefix.clef) items.push({ kind: 'clef', clef: staff.clef });
    if (prefix.keySignature) {
      items.push({ kind: 'keySignature', key: score.meta.key, fifths: keyFifths(score.meta.key) });
    }
    if (prefix.timeSignature) items.push({ kind: 'timeSignature', time: score.meta.time });
    if (bar.startBarline !== 'none') items.push({ kind: 'barline', position: 'start', barline: bar.startBarline });
  }
  items.push(...noteAndRestItems(score, bar, shifts));
  items.push(...tupletBracketItems(bar));
  if (first) items.push({ kind: 'endBarline', position: 'end', barline: bar.endBarline });
  return items;
}

/**
 * Braces for a part with more than one staff (a piano), and one bracket across the whole system when there are several
 * parts. The model has no explicit grouping yet (ADR-0041 leaves families to a later slice), so this derives the one
 * grouping every score has; an explicit group field would replace this function and nothing else.
 */
function groupsOf(lanes: readonly Lane[], staves: readonly LayoutStaff[], systemX: number): LayoutStaffGroup[] {
  const groups: LayoutStaffGroup[] = [];
  const parts = [...new Set(lanes.map((lane) => lane.part.id))];
  let braced = false;
  for (const partId of parts) {
    const indices = lanes.filter((lane) => lane.part.id === partId).map((lane) => lane.index);
    if (indices.length < 2) continue;
    braced = true;
    groups.push({
      kind: 'brace',
      partId,
      firstStaff: indices[0]!,
      lastStaff: indices[indices.length - 1]!,
      x: systemX - GROUP_GAP - BRACE_WIDTH,
      width: BRACE_WIDTH,
      y: 0,
      height: 0,
    });
  }
  if (parts.length > 1) {
    const edge = systemX - GROUP_GAP - (braced ? BRACE_WIDTH + GROUP_GAP : 0);
    groups.push({
      kind: 'bracket',
      partId: null,
      firstStaff: 0,
      lastStaff: staves.length - 1,
      x: edge - BRACKET_WIDTH,
      width: BRACKET_WIDTH,
      y: 0,
      height: 0,
    });
  }
  return groups;
}

/**
 * Give the staves, groups and span their absolute y once the system's top staff line is known (pagination sets it).
 * Idempotent, so layout can build, paginate, rebuild and paginate again.
 */
export function placeLanes(system: LayoutLanes, staveY: number, spec: PageSpec): void {
  for (const staff of system.staves) staff.staveY = staveY + staff.staveOffset;
  const bottom = (index: number): number => (system.staves[index]?.staveY ?? 0) + spec.staffHeight;
  for (const group of system.groups) {
    group.y = system.staves[group.firstStaff]?.staveY ?? staveY;
    group.height = bottom(group.lastStaff) - group.y;
  }
  const span = system.staffSpan;
  span.y = system.staves[span.firstStaff]?.staveY ?? staveY;
  span.height = bottom(span.lastStaff) - span.y;
}
