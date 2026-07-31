import type { Bar, BarMetrics, Id, KeySignature, Score, TimeSignature } from '@sibei/model';
import {
  TICKS_PER_QUARTER,
  barMetrics,
  beatOfOnset,
  keyFifths,
  notesInReadingOrder,
  sectionStartingAt,
  tupletOf,
} from '@sibei/model';
import { resolveBarAccidentals } from './accidentals.js';
import { planSystems } from './grid.js';
import type { LayoutBarItem, LayoutText, LayoutTie } from './items.js';
import type { PageSpec, PageSpecInput } from './page.js';
import { resolvePageSpec } from './page.js';
import type { AllocatedBar, BarPrefix } from './widths.js';
import { allocateWidths } from './widths.js';
import { systemVertical } from './vertical.js';

/**
 * `layout(score, pageSpec) -> positions`. The seam that makes the renderer
 * replaceable (ADR-0014). Runs unchanged in the browser and on the server
 * (ADR-0005), which is why nothing here touches a DOM or a filesystem.
 */

export interface LayoutBar {
  barId: Id;
  barNumber: number;
  isPickup: boolean;
  x: number;
  width: number;
  prefix: BarPrefix;
  /**
   * Room allocated to the clef, key signature and time signature, so an adapter knows
   * where the bar's music starts without guessing it a second time (see `widths.ts`).
   */
  prefixWidth: number;
  /** Derived, carried through so consumers can flag rather than reject (ADR-0013). */
  metrics: BarMetrics;
  items: LayoutBarItem[];
}

export interface LayoutSystem {
  index: number;
  x: number;
  y: number;
  width: number;
  /** Derived from the music: a system with high or low notes is taller (see vertical.ts). */
  height: number;
  aboveStaff: number;
  belowStaff: number;
  /**
   * Units above the top staff line where every chord symbol in this system puts its
   * baseline, so the harmony reads as one line rather than a ragged one.
   */
  chordBaselineOffset: number;
  /** The y of the top staff line. */
  staveY: number;
  bars: LayoutBar[];
  ties: LayoutTie[];
}

export interface LayoutPage {
  index: number;
  widthPt: number;
  heightPt: number;
  width: number;
  height: number;
  /** The title block, on the first page only. */
  header: LayoutText[];
  systems: LayoutSystem[];
}

export interface LayoutResult {
  scoreId: Id;
  pageSpec: PageSpec;
  ticksPerQuarter: number;
  key: KeySignature;
  time: TimeSignature;
  pages: LayoutPage[];
  systemCount: number;
}

export function layout(score: Score, input: PageSpecInput = {}): LayoutResult {
  const spec = resolvePageSpec(input);
  const planned = planSystems(score);

  // System membership is independent of pagination, so ties can be resolved once the
  // systems are known and before they are placed on pages.
  const systemOfNote = new Map<Id, number>();
  planned.forEach((system, index) => {
    for (const bar of [...(system.pickup === null ? [] : [system.pickup]), ...system.bars]) {
      for (const item of bar.items) {
        if (item.kind === 'note') systemOfNote.set(item.id, index);
      }
    }
  });
  const tiesBySystem = planTies(score, systemOfNote);

  const built: LayoutSystem[] = planned.map((system, index) => {
    const allocated = allocateWidths(score, system, spec, { isFirstSystem: index === 0 });
    const bars = allocated.map((entry) => entry.bar);
    const vertical = systemVertical(
      {
        bars,
        hasChords: bars.some((bar) => bar.chords.length > 0 || bar.annotations.length > 0),
        hasRehearsalMark: bars.some((bar) => sectionStartingAt(score, bar.number)?.letter != null),
      },
      spec,
    );

    return {
      index,
      x: spec.margin.left,
      // Placed onto a page below; y is assigned in the pagination pass.
      y: 0,
      width: spec.width - spec.margin.left - spec.margin.right,
      height: vertical.height,
      aboveStaff: vertical.aboveStaff,
      belowStaff: vertical.belowStaff,
      chordBaselineOffset: vertical.chordBaselineOffset,
      staveY: 0,
      bars: allocated.map((entry) => buildBar(score, entry)),
      ties: tiesBySystem.get(index) ?? [],
    };
  });

  return {
    scoreId: score.id,
    pageSpec: spec,
    ticksPerQuarter: TICKS_PER_QUARTER,
    key: score.meta.key,
    time: score.meta.time,
    pages: paginate(score, built, spec),
    systemCount: built.length,
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

function paginate(score: Score, systems: LayoutSystem[], spec: PageSpec): LayoutPage[] {
  const pages: LayoutPage[] = [];
  let page = emptyPage(0, score, spec);
  let y = spec.margin.top + spec.headerHeight;

  for (const system of systems) {
    const overflows = y + system.height > spec.height - spec.margin.bottom;
    if (overflows && page.systems.length > 0) {
      pages.push(page);
      page = emptyPage(pages.length, score, spec);
      y = spec.margin.top;
    }
    system.y = y;
    system.staveY = y + system.aboveStaff;
    page.systems.push(system);
    y += system.height + spec.systemGap;
  }

  pages.push(page);
  return pages;
}

function emptyPage(index: number, score: Score, spec: PageSpec): LayoutPage {
  return {
    index,
    widthPt: spec.widthPt,
    heightPt: spec.heightPt,
    width: spec.width,
    height: spec.height,
    header: index === 0 ? buildHeader(score, spec) : [],
    systems: [],
  };
}

function buildHeader(score: Score, spec: PageSpec): LayoutText[] {
  const texts: LayoutText[] = [];
  const titleBaseline = spec.margin.top + spec.titleSize;
  const subBaseline = titleBaseline + 32;

  if (score.meta.title !== '') {
    texts.push({
      role: 'title',
      text: score.meta.title,
      x: spec.width / 2,
      y: titleBaseline,
      size: spec.titleSize,
      align: 'center',
    });
  }
  if (score.meta.style !== null && score.meta.style !== '') {
    texts.push({
      role: 'style',
      text: score.meta.style,
      x: spec.margin.left,
      y: subBaseline,
      size: spec.styleSize,
      align: 'left',
    });
  }
  if (score.meta.composer !== '') {
    texts.push({
      role: 'composer',
      text: score.meta.composer,
      x: spec.width - spec.margin.right,
      y: subBaseline,
      size: spec.composerSize,
      align: 'right',
    });
  }
  return texts;
}

// ---------------------------------------------------------------------------
// Bar contents
// ---------------------------------------------------------------------------

function buildBar(score: Score, entry: AllocatedBar): LayoutBar {
  const { bar } = entry;
  return {
    barId: bar.id,
    barNumber: bar.number,
    isPickup: entry.isPickup,
    x: entry.x,
    width: entry.width,
    prefix: entry.prefix,
    prefixWidth: entry.prefixWidth,
    metrics: barMetrics(bar, score.meta.time),
    items: buildBarItems(score, bar, entry),
  };
}

function buildBarItems(score: Score, bar: Bar, entry: AllocatedBar): LayoutBarItem[] {
  const time = score.meta.time;
  const items: LayoutBarItem[] = [];

  if (entry.prefix.clef) items.push({ kind: 'clef', clef: 'treble' });
  if (entry.prefix.keySignature) {
    items.push({ kind: 'keySignature', key: score.meta.key, fifths: keyFifths(score.meta.key) });
  }
  if (entry.prefix.timeSignature) items.push({ kind: 'timeSignature', time });

  if (bar.startBarline !== 'none') {
    items.push({ kind: 'barline', position: 'start', barline: bar.startBarline });
  }

  // Bar numbers head each system, by convention not on bar 1 and never on a pickup.
  if (entry.prefix.clef && bar.number > 1) {
    items.push({ kind: 'barNumber', text: String(bar.number) });
  }

  const section = sectionStartingAt(score, bar.number);
  if (section !== null && section.letter !== null) {
    items.push({ kind: 'rehearsalMark', sectionId: section.id, text: section.letter });
  }

  if (bar.ending !== null) {
    items.push({ kind: 'ending', numbers: bar.ending.numbers, role: bar.ending.role });
  }

  const accidentals = resolveBarAccidentals(bar, score.meta.key);
  const ordered = [...bar.items].sort((a, b) => a.onset - b.onset);
  for (const item of ordered) {
    const tuplet = tupletOf(item.id, bar);
    if (item.kind === 'note') {
      items.push({
        kind: 'note',
        noteId: item.id,
        onset: item.onset,
        beat: beatOfOnset(item.onset, time),
        duration: item.duration,
        pitch: item.pitch,
        accidental: item.accidental,
        accidentalGlyph: accidentals.get(item.id) ?? null,
        tie: item.tie,
        tupletId: tuplet === null ? null : tuplet.id,
        flagged: item.review.flagged,
      });
    } else {
      items.push({
        kind: 'rest',
        restId: item.id,
        onset: item.onset,
        beat: beatOfOnset(item.onset, time),
        duration: item.duration,
        tupletId: tuplet === null ? null : tuplet.id,
        flagged: item.review.flagged,
      });
    }
  }

  for (const chord of bar.chords) {
    items.push({
      kind: 'chordSymbol',
      chordId: chord.id,
      onset: chord.onset,
      beat: beatOfOnset(chord.onset, time),
      text: chord.text,
      anchorItemId: anchorFor(bar, chord.onset),
      flagged: chord.review.flagged,
    });
  }

  for (const annotation of bar.annotations) {
    items.push({
      kind: 'annotation',
      annotationId: annotation.id,
      onset: annotation.onset,
      beat: beatOfOnset(annotation.onset, time),
      text: annotation.text,
      anchorItemId: anchorFor(bar, annotation.onset),
      flagged: annotation.review.flagged,
    });
  }

  for (const tuplet of bar.tuplets) {
    items.push({
      kind: 'tupletBracket',
      tupletId: tuplet.id,
      actual: tuplet.actual,
      normal: tuplet.normal,
      memberIds: tuplet.memberIds,
    });
  }

  items.push({ kind: 'endBarline', position: 'end', barline: bar.endBarline });

  return items;
}

/** The onset at or before this one, which is what a chord symbol sits above. */
function anchorFor(bar: Bar, onset: number): Id | null {
  let best: { id: Id; onset: number } | null = null;
  for (const item of bar.items) {
    if (item.onset > onset) continue;
    if (best === null || item.onset > best.onset) best = { id: item.id, onset: item.onset };
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------------------
// Ties
// ---------------------------------------------------------------------------

/**
 * Ties are resolved across the whole score, then assigned to systems. A tie whose
 * ends straddle a system break becomes two half-ties, one on each side.
 */
function planTies(score: Score, systemOfNote: Map<Id, number>): Map<number, LayoutTie[]> {
  const bySystem = new Map<number, LayoutTie[]>();
  const push = (system: number, tie: LayoutTie): void => {
    const list = bySystem.get(system);
    if (list === undefined) bySystem.set(system, [tie]);
    else list.push(tie);
  };

  let pending: Id | null = null;
  for (const { note } of notesInReadingOrder(score)) {
    const closes = note.tie === 'stop' || note.tie === 'both';
    const opens = note.tie === 'start' || note.tie === 'both';

    if (closes && pending !== null) {
      const from = systemOfNote.get(pending);
      const to = systemOfNote.get(note.id);
      if (from !== undefined && to !== undefined) {
        if (from === to) {
          push(from, { fromNoteId: pending, toNoteId: note.id });
        } else {
          push(from, { fromNoteId: pending, toNoteId: null });
          push(to, { fromNoteId: null, toNoteId: note.id });
        }
      }
      pending = null;
    }
    if (opens) pending = note.id;
  }

  // A dangling tie start has nothing to tie to. It is a defect in the score, not
  // something to draw; flagging it belongs with the import review flags (V11).
  return bySystem;
}
