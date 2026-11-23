import type { BarView, BarMetrics, ChordStylePreset, Id, KeySignature, Note, Score, Staff, TimeSignature } from '@sibei/model';
import {
  TICKS_PER_QUARTER,
  annotationsOfBar,
  barMetrics,
  barView,
  beatOfOnset,
  keyFifths,
  notesInReadingOrder,
  notesOf,
  sectionStartingAt,
  tupletOf,
} from '@sibei/model';
import { clefChangeOf, effectiveClef, hasClefChanges } from './clefs.js';
import { noteAndRestItems, tupletBracketItems } from './bar-items.js';
import { planSystems } from './grid.js';
import { buildFurniture, footerReserve } from './furniture.js';
import type { Lane, LayoutAlignment, LayoutStaff, LayoutStaffGroup, LayoutStaffSpan } from './lanes.js';
import { buildLanes, fitFor, isMultiLane, lanesOf, placeLanes, sizingFor, voiceStems, voiceViewsOf } from './lanes.js';
import type { LayoutFurniture } from './furniture.js';
import type { Clef, LayoutBarItem, LayoutOttava, LayoutSlur, LayoutText, LayoutTie } from './items.js';
import { ottavaShifts, planOttavas } from './ottava.js';
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
  /**
   * The shared horizontal spacing of this bar across every staff and voice: where its music runs from and to, and the x
   * of each onset. Present only on a multi-staff or multi-voice system (SIB2-227).
   */
  alignment?: LayoutAlignment;
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
  /** The slurs on this system, a half-slur where one crosses a system break (SIB2-168). */
  slurs: LayoutSlur[];
  /** The ottava lines on this system (SIB2-184); empty for almost every chart. */
  ottavas: LayoutOttava[];
  /** Units above the top staff line of an 8va line, and below the bottom staff line of an 8vb one. */
  ottavaAboveOffset?: number;
  ottavaBelowOffset?: number;
  /**
   * The staves of a multi-staff system, top to bottom, each with its voices' items, clef, y and ties; the braces and
   * bracket joining them; and the run a barline makes across them (SIB2-227). All three are absent on a single-staff
   * single-voice chart, whose one staff is `bars` and `staveY` above. `aboveStaff` and the chord row belong to the top
   * staff; `belowStaff` is under the bottom one.
   */
  staves?: LayoutStaff[];
  groups?: LayoutStaffGroup[];
  staffSpan?: LayoutStaffSpan;
  /** An empty ruled staff added to fill the last page (SIB2-181): clef and staff lines, no bars. */
  blank?: true;
}

export interface LayoutPage {
  index: number;
  widthPt: number;
  heightPt: number;
  width: number;
  height: number;
  /** The title block, on the first page only. */
  header: LayoutText[];
  /** Page numbers and other furniture, in the margin bands (SIB2-171). Empty by default. */
  furniture: LayoutFurniture[];
  systems: LayoutSystem[];
}

export interface LayoutResult {
  scoreId: Id;
  pageSpec: PageSpec;
  ticksPerQuarter: number;
  key: KeySignature;
  time: TimeSignature;
  /** The score's chosen chord symbology (SIB2-163), carried for the engraver; absent is `standard`. */
  chordStyle?: ChordStylePreset;
  pages: LayoutPage[];
  systemCount: number;
}

export function layout(score: Score, input: PageSpecInput = {}): LayoutResult {
  const spec = resolvePageSpec(input);
  // More than one staff, or two voices with music: the staves path (lanes.ts, SIB2-227). Everything it adds is
  // optional on the output, and a single-staff single-voice chart never enters it.
  const multi = isMultiLane(score);
  const lanes = lanesOf(score);
  const sizing = multi ? sizingFor(score, lanes) : undefined;
  const planned = planSystems(
    score,
    score.meta.layout === 'score' ? fitFor(score, lanes, spec, (bar) => bar.id === score.bars[0]?.id) : undefined,
  );

  // System membership is independent of pagination, so ties can be resolved once the
  // systems are known and before they are placed on pages.
  const systemOfNote = new Map<Id, number>();
  // Which staff of a multi-staff score a note is on, so an ottava line can be drawn on its own staff (SIB2-233).
  const staffOfNote = new Map<Id, number>();
  planned.forEach((system, index) => {
    for (const bar of [...(system.pickup === null ? [] : [system.pickup]), ...system.bars]) {
      for (const item of bar.items) {
        if (item.kind === 'note') systemOfNote.set(item.id, index);
      }
      // The other staves and voices: their notes are on this system too, for ties and slurs.
      if (multi) {
        for (const lane of lanes) {
          for (const voice of voiceViewsOf(score, lane.staff, bar)) {
            for (const item of voice.view.items) {
              if (item.kind === 'note') systemOfNote.set(item.id, index);
              if (item.kind === 'note') staffOfNote.set(item.id, lanes.indexOf(lane));
            }
          }
        }
      }
    }
  });
  const tiesBySystem = planTies(notesInReadingOrder(score).map((entry) => entry.note), systemOfNote);
  const tiesByStaff = multi ? planLaneTies(score, lanes, systemOfNote) : new Map<Id, Map<number, LayoutTie[]>>();
  const slursBySystem = planSlurs(score, systemOfNote);
  const ottavasBySystem = planOttavas(score, systemOfNote, multi ? staffOfNote : undefined);
  const shifts = ottavaShifts(score);

  // Which systems draw the clef and key signature (SIB2-173). Widths depend on it, pagination does not
  // (a system's height comes from its notes, never its width), so for the `page` policy the systems are
  // built once, paginated to learn which one heads each page, and rebuilt with that answer.
  const policy = score.meta.signaturePolicy ?? 'every';
  const buildSystems = (showsSignatures: (index: number) => boolean): LayoutSystem[] =>
    planned.map((system, index) => {
      const allocated = allocateWidths(score, system, spec, {
        isFirstSystem: index === 0,
        showSignatures: showsSignatures(index),
        ...(sizing === undefined ? {} : { sizing }),
      });
      const bars = allocated.map((entry) => entry.bar);
      const top = multi ? lanes[0] : undefined;
      const vertical = systemVertical(
        {
          // The top staff's ink is every voice of it; the other staves are stacked below (lanes.ts).
          bars: top === undefined ? bars : allocated.flatMap((entry) => voiceViewsOf(score, top.staff, entry.bar).map((voice) => voice.view)),
          ...(top === undefined
            ? {}
            : {
                clef: top.staff.clef,
                stems: voiceStems(allocated.map((entry) => voiceViewsOf(score, top.staff, entry.bar)), shifts),
              }),
          shifts,
          ...(top === undefined ? {} : { lowFermatas: true }),
          ...(top !== undefined && hasClefChanges(score, top.staff)
            ? { clefOf: (view: BarView) => effectiveClef(score, top.staff, view.id) }
            : {}),
          ottavaAbove: (ottavasBySystem.get(index) ?? []).some((line) => line.shift === 'up' && line.staff === undefined),
          ottavaBelow: (ottavasBySystem.get(index) ?? []).some((line) => line.shift === 'down' && line.staff === undefined),
          hasChords: bars.some((bar) => bar.chords.length > 0 || bar.annotations.length > 0),
          hasNavMark: bars.some((bar) => (bar.nav ?? []).length > 0),
          hasRehearsalMark:
            bars.some((bar) => hasMark(sectionStartingAt(score, bar.number))) ||
            // The tempo mark takes the same band as a rehearsal letter (SIB2-177).
            (index === 0 && score.meta.tempo !== undefined),
        },
        spec,
      );

      const layoutBars = allocated.map((entry) => buildBar(score, entry, shifts, spec.barNumbers, top?.staff));
      const built: LayoutSystem = {
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
        bars: layoutBars,
        ties: tiesBySystem.get(index) ?? [],
        slurs: slursBySystem.get(index) ?? [],
        ottavas: ottavasBySystem.get(index) ?? [],
        ...(vertical.ottavaAboveOffset === undefined ? {} : { ottavaAboveOffset: vertical.ottavaAboveOffset }),
        ...(vertical.ottavaBelowOffset === undefined ? {} : { ottavaBelowOffset: vertical.ottavaBelowOffset }),
      };
      if (multi) {
        const lanesBuilt = buildLanes({
          score,
          spec,
          lanes,
          allocated,
          topBars: layoutBars,
          shifts,
          vertical,
          systemX: built.x,
          tiesByStaff,
          systemIndex: index,
          ottavas: built.ottavas,
        });
        built.height = lanesBuilt.height;
        built.belowStaff = lanesBuilt.belowStaff;
        built.staves = lanesBuilt.staves;
        built.groups = lanesBuilt.groups;
        built.staffSpan = lanesBuilt.staffSpan;
        layoutBars.forEach((bar, barIndex) => {
          const alignment = lanesBuilt.alignments[barIndex];
          if (alignment !== undefined) bar.alignment = alignment;
        });
      }
      return built;
    });

  let built = buildSystems((index) => policy === 'every' || index === 0);
  if (policy === 'page') {
    const headsPage = new Set(paginate(score, built, spec).map((page) => page.systems[0]?.index ?? 0));
    built = buildSystems((index) => index === 0 || headsPage.has(index));
  }

  return {
    scoreId: score.id,
    pageSpec: spec,
    ticksPerQuarter: TICKS_PER_QUARTER,
    key: score.meta.key,
    time: score.meta.time,
    ...(score.meta.chordStyle === undefined ? {} : { chordStyle: score.meta.chordStyle }),
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
  let y = spec.margin.top + headerBand(page.header, spec);
  const bottom = spec.height - spec.margin.bottom - footerReserve(score, spec);

  for (const system of systems) {
    const overflows = y + system.height > bottom;
    if (overflows && page.systems.length > 0) {
      pages.push(page);
      page = emptyPage(pages.length, score, spec);
      y = spec.margin.top;
    }
    system.y = y;
    system.staveY = y + system.aboveStaff;
    if (system.staves !== undefined && system.groups !== undefined && system.staffSpan !== undefined) {
      placeLanes({ staves: system.staves, groups: system.groups, staffSpan: system.staffSpan }, system.staveY, spec);
    }
    page.systems.push(system);
    y += system.height + spec.systemGap;
  }

  // Empty staves to the foot of the last page, when asked (SIB2-181). Only the room the page really has, so a
  // chart that already fills its last page gets none, and no extra page is ever started for them.
  if (spec.blankStaves) {
    const height = spec.aboveStaff + spec.staffHeight + spec.belowStaff;
    while (y + height <= bottom) {
      page.systems.push({
        index: systems.length + page.systems.filter((s) => s.blank === true).length,
        x: spec.margin.left,
        y,
        width: spec.width - spec.margin.left - spec.margin.right,
        height,
        aboveStaff: spec.aboveStaff,
        belowStaff: spec.belowStaff,
        chordBaselineOffset: 0,
        staveY: y + spec.aboveStaff,
        bars: [],
        ties: [],
        slurs: [],
        ottavas: [],
        blank: true,
      });
      y += height + spec.systemGap;
    }
  }

  pages.push(page);
  // The page count is only known now, and "Page 2 of 3" needs it.
  for (const each of pages) each.furniture = buildFurniture(score, each.index, pages.length, spec);
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
    furniture: [],
    systems: [],
  };
}

/** The style line and the composer share a row this far below the title's baseline. */
const SUB_ROW_GAP = 32;
/** The subtitle's baseline below the title's, and the step between stacked composer/arranger lines. */
const SUBTITLE_GAP = 26;
const CREDIT_LINE_GAP = 20;

/**
 * How far below the top margin page 1's first system sits — derived from the ink the
 * title block actually put on the page, not reserved unconditionally (KAN-525).
 *
 * `buildHeader` emits a title only for a score that has one, a style line only for a
 * score that has one, and a composer only for a score that has one, so it may emit
 * nothing at all. Reserving `spec.headerHeight` regardless printed an untitled,
 * uncredited chart an inch and a half down the page under a title block that was never
 * drawn — and a browser (V4) creates exactly that score every time somebody starts a
 * chart before naming it.
 *
 * Three fixes were on the table: collapse the band whenever the header is empty, reserve
 * something smaller so that typing a title later does not reflow the chart, or call the
 * white space deliberate. Measuring the ink subsumes the first — with no header there is
 * nothing to clear, so page 1 starts at `margin.top` exactly as a continuation page
 * already does — and it needs no constant of its own to do it. The reflow worry behind
 * the second is real, but it is a UI concern with a UI answer, and buying it with
 * permanent white space on every untitled printout is the wrong trade.
 *
 * The clearance below the last baseline is derived rather than invented: `headerHeight`
 * keeps its meaning as the room a *full* title block wants, so whatever it has left over
 * once the full block's own rows are accounted for is the gap every header gets. Same
 * rule as the engraver's — if the geometry is available, do not tune a number (ADR-0030).
 */
function headerBand(header: LayoutText[], spec: PageSpec): number {
  if (header.length === 0) return 0;
  const lowestBaseline = Math.max(...header.map((text) => text.y));
  const clearance = spec.headerHeight - (spec.titleSize + SUB_ROW_GAP);
  return Math.max(0, lowestBaseline - spec.margin.top + clearance);
}

function buildHeader(score: Score, spec: PageSpec): LayoutText[] {
  const texts: LayoutText[] = [];
  const titleBaseline = spec.margin.top + spec.titleSize;
  // A subtitle sits between the title and the style/composer row, which then drops by one row (SIB2-180).
  const subtitle = score.meta.subtitle ?? '';
  const subtitleBaseline = titleBaseline + SUBTITLE_GAP;
  const subBaseline = subtitle === '' ? titleBaseline + SUB_ROW_GAP : subtitleBaseline + SUB_ROW_GAP - 4;

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
  if (subtitle !== '') {
    texts.push({
      role: 'subtitle',
      text: subtitle,
      x: spec.width / 2,
      y: subtitleBaseline,
      size: spec.styleSize + 3,
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
  // Composer lines, then the arranger, stack down the right edge one credit line each (SIB2-180).
  let creditBaseline = subBaseline;
  const credits: Array<['composer' | 'arranger', string]> = [
    ...score.meta.composer.split('\n').filter((line) => line.trim() !== '').map((line): ['composer', string] => ['composer', line]),
    ...((score.meta.arranger ?? '') === '' ? [] : [['arranger', score.meta.arranger ?? ''] as ['arranger', string]]),
  ];
  for (const [role, line] of credits) {
    texts.push({
      role,
      text: line,
      x: spec.width - spec.margin.right,
      y: creditBaseline,
      size: spec.composerSize,
      align: 'right',
    });
    creditBaseline += CREDIT_LINE_GAP;
  }
  return texts;
}

// ---------------------------------------------------------------------------
// Bar contents
// ---------------------------------------------------------------------------

/** A section draws a mark when it has a letter or a name (SIB2-176); a name alone is boxed by itself. */
function hasMark(section: { letter: string | null; name: string | null } | null): boolean {
  return section !== null && (section.letter != null || (section.name != null && section.name !== ''));
}

function buildBar(
  score: Score,
  entry: AllocatedBar,
  shifts: Map<Id, 'up' | 'down'>,
  barNumbers: boolean,
  staff?: Staff,
): LayoutBar {
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
    items: buildBarItems(score, bar, entry, shifts, barNumbers, staff),
  };
}

function buildBarItems(
  score: Score,
  bar: BarView,
  entry: AllocatedBar,
  shifts: Map<Id, 'up' | 'down'>,
  barNumbers: boolean,
  staff: Staff | undefined,
): LayoutBarItem[] {
  const time = score.meta.time;
  const items: LayoutBarItem[] = [];

  if (entry.prefix.clef) items.push({ kind: 'clef', clef: staff === undefined ? 'treble' : effectiveClef(score, staff, bar.id) });
  else if (entry.prefix.clefChange === true && staff !== undefined) {
    const change = clefChangeOf(score, staff, bar.id);
    if (change !== null) items.push({ kind: 'clef', clef: change, change: true });
  }
  if (entry.prefix.keySignature) {
    items.push({ kind: 'keySignature', key: score.meta.key, fifths: keyFifths(score.meta.key) });
  }
  if (entry.prefix.timeSignature) items.push({ kind: 'timeSignature', time });

  if (bar.startBarline !== 'none') {
    items.push({ kind: 'barline', position: 'start', barline: bar.startBarline });
  }

  // Bar numbers head each system, by convention not on bar 1 and never on a pickup.
  if (barNumbers && entry.headsSystem && bar.number > 1) {
    items.push({ kind: 'barNumber', text: String(bar.number) });
  }

  const section = sectionStartingAt(score, bar.number);
  if (section !== null && hasMark(section)) {
    items.push({
      kind: 'rehearsalMark',
      sectionId: section.id,
      text: section.letter ?? '',
      // A name that only repeats the letter ("A" beside A) adds nothing, so it is not boxed twice.
      ...(section.name && section.name !== section.letter ? { name: section.name } : {}),
    });
  }

  // On the first numbered bar, not a pickup: a pickup is a stub of a bar, and a mark that long would run into the
  // next bar's rehearsal box. A pickup chart's mark therefore starts just after the pickup.
  if (score.meta.tempo !== undefined && bar.id === (score.bars.find((b) => b.number !== 0) ?? score.bars[0])?.id) {
    items.push({ kind: 'tempo', unit: score.meta.tempo.unit, bpm: score.meta.tempo.bpm });
  }

  for (const nav of bar.nav ?? []) items.push({ kind: 'nav', nav });

  if (bar.ending !== null) {
    items.push({ kind: 'ending', numbers: bar.ending.numbers, role: bar.ending.role });
  }

  items.push(...noteAndRestItems(score, bar, shifts));

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
    const end = annotation.lineEndBarId === undefined ? undefined : score.bars.find((b) => b.id === annotation.lineEndBarId);
    items.push({
      kind: 'annotation',
      annotationId: annotation.id,
      onset: annotation.onset,
      beat: beatOfOnset(annotation.onset, time),
      text: annotation.text,
      anchorItemId: anchorFor(bar, annotation.onset),
      flagged: annotation.review.flagged,
      ...(end !== undefined && end.number >= bar.number ? { line: { endsHere: end.number === bar.number } } : {}),
    });
  }

  // The bars a dashed line passes through or closes on (SIB2-170), from any earlier bar's direction.
  for (const earlier of score.bars) {
    if (earlier.number >= bar.number) continue;
    for (const annotation of annotationsOfBar(score, earlier.id)) {
      const end = annotation.lineEndBarId === undefined ? undefined : score.bars.find((b) => b.id === annotation.lineEndBarId);
      if (end !== undefined && end.number >= bar.number) {
        items.push({ kind: 'directionLine', annotationId: annotation.id, endsHere: end.number === bar.number });
      }
    }
  }

  items.push(...tupletBracketItems(bar));

  items.push({ kind: 'endBarline', position: 'end', barline: bar.endBarline });

  return items;
}

/** The onset at or before this one, which is what a chord symbol sits above. */
function anchorFor(bar: BarView, onset: number): Id | null {
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
function planTies(notes: readonly Note[], systemOfNote: Map<Id, number>): Map<number, LayoutTie[]> {
  const bySystem = new Map<number, LayoutTie[]>();
  const push = (system: number, tie: LayoutTie): void => {
    const list = bySystem.get(system);
    if (list === undefined) bySystem.set(system, [tie]);
    else list.push(tie);
  };

  let pending: Id | null = null;
  for (const note of notes) {
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

// ---------------------------------------------------------------------------
// Slurs
// ---------------------------------------------------------------------------

/**
 * Slurs name their two notes (a `Spanner`), so unlike a tie there is nothing to pair up: each is
 * placed on the system its start note is on, and one that ends on a later system becomes two
 * half-slurs, as a tie does. A slur whose note has gone (a stale id) is not drawn.
 */
function planSlurs(score: Score, systemOfNote: Map<Id, number>): Map<number, LayoutSlur[]> {
  const bySystem = new Map<number, LayoutSlur[]>();
  const push = (system: number, slur: LayoutSlur): void => {
    const list = bySystem.get(system);
    if (list === undefined) bySystem.set(system, [slur]);
    else list.push(slur);
  };
  for (const spanner of score.spanners ?? []) {
    if (spanner.kind !== 'slur') continue;
    const from = systemOfNote.get(spanner.startId);
    const to = systemOfNote.get(spanner.endId);
    if (from === undefined || to === undefined) continue;
    const placement = spanner.placement === undefined ? {} : { placement: spanner.placement };
    if (from === to) {
      push(from, { id: spanner.id, fromNoteId: spanner.startId, toNoteId: spanner.endId, ...placement });
    } else {
      push(from, { id: spanner.id, fromNoteId: spanner.startId, toNoteId: null, ...placement });
      push(to, { id: spanner.id, fromNoteId: null, toNoteId: spanner.endId, ...placement });
    }
  }
  return bySystem;
}

/**
 * Ties on every staff and voice (SIB2-227): each voice is its own line, so a tie pairs within a voice, never across the
 * staves. Keyed by staff id, then system index; the top staff's first voice resolves exactly as `system.ties` does.
 */
function planLaneTies(
  score: Score,
  lanes: readonly Lane[],
  systemOfNote: Map<Id, number>,
): Map<Id, Map<number, LayoutTie[]>> {
  const result = new Map<Id, Map<number, LayoutTie[]>>();
  for (const lane of lanes) {
    const merged = new Map<number, LayoutTie[]>();
    const voices = new Set<number>([1]);
    for (const staffBar of lane.staff.bars) for (const voice of staffBar.voices) voices.add(voice.index);
    for (const index of [...voices].sort((a, b) => a - b)) {
      const notes = score.bars.flatMap((bar) => notesOf(barView(score, bar, { staff: lane.staff.id, voice: index })));
      for (const [system, ties] of planTies(notes, systemOfNote)) {
        merged.set(system, [...(merged.get(system) ?? []), ...ties]);
      }
    }
    result.set(lane.staff.id, merged);
  }
  return result;
}
