import type {
  EndingItem,
  LayoutBar,
  LayoutBarItemKind,
  LayoutStaff,
  LayoutStaffGroup,
  LayoutStaffSpan,
  LayoutResult,
  LayoutSystem,
  NoteItem,
  RestItem,
} from '@sibei/layout';
import { ARTICULATION_BAND, LAYOUT_BAR_ITEM_KINDS, NAV_BAND, writtenPitch } from '@sibei/layout';
import type { Clef, Id, TimeSignature } from '@sibei/model';
import { TICKS_PER_WHOLE, beatTicks, durationTicks, headOf } from '@sibei/model';
import { furnitureText } from './furniture.js';
import type { BarlineJoin } from './barlines.js';
import { endBarline, ending, openingBarline, startBarline } from './barlines.js';
import { staffGroups } from './groups.js';
import type { StemMerge, VoiceShift } from './voices.js';
import { noteShifts, stemFlips, stemMerges, restShiftOf, stemsOf, voicesWithMusic } from './voices.js';
import type { BeamCandidate } from './beam-groups.js';
import { beamGroupIndices, secondaryBreaks } from './beam-groups.js';
import type { BeamMember } from './beams.js';
import { applyBeam, beamElements, beamLine } from './beams.js';
import type { MusicFont, MusicGlyphName } from './font.js';
import { units } from './font.js';
import type { MusicFontName } from './fonts/index.js';
import { DEFAULT_MUSIC_FONT, musicFontNamed } from './fonts/index.js';
import { restFor, restPosition } from './rests.js';
import {
  flaggedChordShade,
  flaggedItemShade,
  invalidBarShade,
} from './shading.js';
import { CLEF_CHANGE_SIZE, clef, clefWidth, keySignature, timeSignature } from './signatures.js';
import type { PlacedItem } from './spacing.js';
import { ACCIDENTAL_GAP, accidentalGlyph, placeAligned, placeItems } from './spacing.js';
import { ledgerLines, positionY, staffLines, staffPosition, staffPositionIn } from './staff.js';
import type { Stem, StemDirection } from './stems.js';
import {
  beamCount,
  dotPositions,
  flagFor,
  flagOrigin,
  groupStemDirection,
  hasStem,
  noteheadFor,
  percussionNoteheadFor,
  drumNoteheadFor,
  stem,
  stemDirection,
  stemElement,
} from './stems.js';
import type { SvgElement } from './svg.js';
import { el, serialise } from './svg.js';
import type { TieEnd } from './ties.js';
import { tie } from './ties.js';
import { slur } from './slurs.js';
import { articulations, fermata, fermataBelow } from './marks.js';
import { graceInk } from './graces.js';
import type { ChordStyle } from './text.js';
import {
  CANONICAL_CHORD_STYLE,
  chordStyleForPreset,
  DEFAULT_TEXT_FONT,
  chordGlyphText,
  chordSymbol,
  headerText,
  rehearsalBoxWidth,
  rehearsalMark,
  text,
} from './text.js';
import { navMark } from './nav.js';
import { ottavaLine } from './ottava.js';
import { tempoMark } from './tempo.js';
import { tuplet } from './tuplets.js';

/**
 * The engraver (ADR-0030): a draw adapter that engraves from a SMuFL font's published
 * metrics instead of through VexFlow.
 *
 * It consumes the layout contract and nothing else, exactly as `@sibei/draw` does, and it
 * differs in two ways worth noting. It emits **markup rather than DOM nodes**, so it needs
 * no `document` and this package stays as framework-free as `layout` and `model`. And the
 * **face is an argument**, because a lead sheet is read in a handwritten Real Book face as
 * often as an engraved one and that is the reader's choice per render.
 *
 * Order of work inside a bar is load-bearing, and it is the lesson of V1's beaming bug:
 * **all geometry, then all ink.** Nothing is emitted until every beam has been fitted and
 * every stem end rewritten from it, so a note can never be asked twice whether it is
 * beamed and answer differently.
 */

export interface EngraveOptions {
  /**
   * Which face to engrave in. Threaded through every geometry function rather than
   * imported by them, so a face is chosen per render.
   */
  font: MusicFontName;
  /** Off for the side-by-side, where the other adapter's staff is already underneath. */
  staffLines: boolean;
  /** Chord symbol size, in layout units. */
  chordFontSize: number;
  barNumberFontSize: number;
  rehearsalFontSize: number;
  endingFontSize: number;
  /**
   * Chord-symbol typography (V17a): which glyphs a quality draws — `Δ` vs `maj`, `ø` vs a spelled
   * `m7♭5`, and so on. Defaults to the canonical style every surface used before, so a plain render
   * is byte-identical (ADR-0014/0015); a corpus varies it to teach a recogniser real spellings.
   */
  chordStyle: ChordStyle;
  /**
   * The text font family for the title block and chord symbols (V17a). Defaults to the serif every
   * surface used before. Bar numbers and rehearsal marks stay serif — they are not recognition targets.
   */
  textFont: string;
}

/**
 * The chord symbol size a default render uses, in layout units. Exported so a consumer that
 * hit-tests chord symbols (the browser, V5e) sizes its targets from the same number the ink was
 * drawn at, rather than a second copy of it that could drift.
 */
export const DEFAULT_CHORD_FONT_SIZE = 14;

const DEFAULT_OPTIONS: EngraveOptions = {
  font: DEFAULT_MUSIC_FONT,
  staffLines: true,
  chordFontSize: DEFAULT_CHORD_FONT_SIZE,
  barNumberFontSize: 11,
  rehearsalFontSize: 13,
  endingFontSize: 11,
  chordStyle: CANONICAL_CHORD_STYLE,
  textFont: DEFAULT_TEXT_FONT,
};

export interface EngravedPage {
  /** Standalone SVG markup, in the same coordinates and at the same size as `@sibei/draw`. */
  svg: string;
  /**
   * Item kinds this adapter passed over. Empty now that it draws them all, and kept
   * because an engraver that quietly drops a glyph is worse than one that says so.
   */
  skipped: readonly { kind: LayoutBarItemKind; count: number }[];
}

/** Every kind this adapter draws — which is every kind the contract can emit. */
export const ENGRAVED_ITEM_KINDS: readonly LayoutBarItemKind[] = LAYOUT_BAR_ITEM_KINDS;

export function engravePage(
  result: LayoutResult,
  pageIndex: number,
  options: Partial<EngraveOptions> = {},
): EngravedPage {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  // The score's own chord symbology (SIB2-163) unless a caller named a style outright (the OMR corpus does).
  if (options.chordStyle === undefined) opts.chordStyle = chordStyleForPreset(result.chordStyle);
  const page = result.pages[pageIndex];
  if (page === undefined) throw new Error(`no such page: ${pageIndex}`);

  const font = musicFontNamed(opts.font);
  const skipped = new Map<LayoutBarItemKind, number>();
  const children: SvgElement[] = page.header.map((item) => headerText(item, opts.textFont));

  children.push(...page.furniture.map((item) => furnitureText(item, opts.textFont)));

  for (const system of page.systems) {
    children.push(...engraveSystem(font, system, result.time, opts, skipped));
  }

  const svg = el(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      viewBox: `0 0 ${page.width} ${page.height}`,
      width: `${page.widthPt}pt`,
      height: `${page.heightPt}pt`,
    },
    children,
  );

  return {
    svg: serialise(svg),
    skipped: [...skipped].map(([kind, count]) => ({ kind, count })),
  };
}

// ---------------------------------------------------------------------------
// A system
// ---------------------------------------------------------------------------

/** What a tie needs to know about a note, gathered as the bars are engraved. */
type NoteAnchors = Map<Id, TieEnd>;

interface Bands {
  /** Top of the system's above-staff band, where marks and brackets live. */
  top: number;
  /** Where the rehearsal, tempo and ending row starts: `top`, or below the navigation row when the system has one. */
  markTop: number;
  /** Where every chord symbol in this system puts its baseline. */
  chordBaseline: number;
}

export function engraveSystem(
  font: MusicFont,
  system: LayoutSystem,
  time: TimeSignature,
  options: EngraveOptions,
  skipped: Map<LayoutBarItemKind, number>,
): SvgElement[] {
  if (system.staves !== undefined && system.staffSpan !== undefined) {
    return engraveStavedSystem(font, system, system.staves, system.staffSpan, system.groups ?? [], time, options, skipped);
  }
  // Only the head of a system gets an opening line: elsewhere the previous bar's closing
  // barline is the junction, and two lines at one x would double it up. A system that
  // opens on a repeat already has its own thick line there, and would double it the same
  // way — visible immediately in the proof of bar 12.
  const opensOnRepeat = system.bars[0]?.items.some((item) => item.kind === 'barline') ?? false;

  const top = system.staveY - system.aboveStaff;
  const bands: Bands = {
    top,
    markTop: top + (system.bars.some((bar) => bar.items.some((item) => item.kind === 'nav')) ? NAV_BAND : 0),
    chordBaseline: system.staveY - system.chordBaselineOffset,
  };

  // Review shading is a wash behind everything, so it is gathered first and emitted before a
  // single stroke of ink — the staff lines included (V14c). Drawing it after would occlude
  // the notation it is meant to highlight, which is the whole point of `all geometry, then
  // all ink` one z-layer down.
  const shading: SvgElement[] = [];
  const barInk: SvgElement[] = [];
  const anchors: NoteAnchors = new Map();
  for (const bar of system.bars) {
    barInk.push(...engraveBar(font, bar, system, time, options, bands, anchors, shading, skipped));
  }

  const children: SvgElement[] = [...shading];
  if (options.staffLines) {
    children.push(...staffLines(font, { x: system.x, width: system.width, staveY: system.staveY }));
    if (!opensOnRepeat) children.push(openingBarline(font, system.x, system.staveY));
  }
  children.push(...barInk);
  if (system.blank === true && options.staffLines) {
    // An empty staff for writing in (SIB2-181): a clef and a closing line, nothing else.
    children.push(clef(font, system.x + units(0.6), system.staveY));
    children.push(...endBarline(font, 'single', system.x + system.width, system.staveY));
  }

  // Where this system's *music* begins, which is past the clef and key signature rather
  // than at the system's left edge: a half-tie arriving from the previous system runs
  // back to here, and running it to the edge drew it through the key signature.
  const opening = system.bars[0];
  const musicLeft = opening === undefined ? system.x : opening.x + opening.prefixWidth;

  for (const layoutTie of system.ties) {
    const curve = tie(font, {
      from: layoutTie.fromNoteId === null ? null : (anchors.get(layoutTie.fromNoteId) ?? null),
      to: layoutTie.toNoteId === null ? null : (anchors.get(layoutTie.toNoteId) ?? null),
      systemLeft: musicLeft,
      systemRight: system.x + system.width,
    });
    if (curve !== null) children.push(curve);
  }

  // Slurs go over everything else in the system: they bridge notes, so they need every note's extent.
  for (const layoutSlur of system.slurs) {
    const from = layoutSlur.fromNoteId === null ? null : (anchors.get(layoutSlur.fromNoteId) ?? null);
    const to = layoutSlur.toNoteId === null ? null : (anchors.get(layoutSlur.toNoteId) ?? null);
    const lowest = Math.min(from?.x ?? musicLeft, to?.x ?? musicLeft);
    const highest = Math.max(from?.x ?? system.x + system.width, to?.x ?? system.x + system.width);
    const under = [...anchors.values()].filter((end) => end.x >= lowest && end.x <= highest);
    const curve = slur(font, {
      from,
      to,
      under,
      placement: layoutSlur.placement,
      systemLeft: musicLeft,
      systemRight: system.x + system.width,
      ceiling: bands.chordBaseline,
    });
    if (curve !== null) children.push(curve);
  }

  // Ottava lines (SIB2-184): 8va above the staff, 8vb below, at the height layout reserved for them.
  for (const line of system.ottavas) {
    const y =
      line.shift === 'up'
        ? system.ottavaAboveOffset === undefined
          ? undefined
          : system.staveY - system.ottavaAboveOffset
        : system.ottavaBelowOffset === undefined
          ? undefined
          : system.staveY + units(4) + system.ottavaBelowOffset;
    if (y === undefined) continue;
    const from = line.fromNoteId === null ? undefined : anchors.get(line.fromNoteId);
    const to = line.toNoteId === null ? undefined : anchors.get(line.toNoteId);
    children.push(
      ...ottavaLine({
        shift: line.shift,
        from: from === undefined ? musicLeft : from.x,
        to: to === undefined ? system.x + system.width : to.x + to.noteheadWidth,
        y,
        labelled: line.labelled,
        hooked: line.toNoteId !== null,
        size: options.chordFontSize * 0.9,
      }),
    );
  }

  return children;
}

// ---------------------------------------------------------------------------
// A system of several staves or voices (ADR-0041, slice 4)
// ---------------------------------------------------------------------------

/**
 * A system that layout has stacked into staves. Everything about where things go was decided there: each staff's top
 * line (`staveY`), each bar's shared columns (every note's `x`), the groups and the run a barline makes. What is
 * drawn here is the same vocabulary as the single-staff path, one staff at a time, plus what only exists once there are
 * several: the brace and bracket, barlines through every staff, a clef of each kind and voices that give way to each
 * other. `all geometry, then all ink` holds per call of `engraveBar`; the system's own lines go down first.
 *
 * Chords, text, rehearsal marks and bar numbers stay above the top staff only, and are the top staff's first voice's.
 */
function engraveStavedSystem(
  font: MusicFont,
  system: LayoutSystem,
  staves: readonly LayoutStaff[],
  span: LayoutStaffSpan,
  groups: readonly LayoutStaffGroup[],
  time: TimeSignature,
  options: EngraveOptions,
  skipped: Map<LayoutBarItemKind, number>,
): SvgElement[] {
  const top = system.staveY - system.aboveStaff;
  const bands: Bands = {
    top,
    markTop: top + (system.bars.some((bar) => bar.items.some((item) => item.kind === 'nav')) ? NAV_BAND : 0),
    chordBaseline: system.staveY - system.chordBaselineOffset,
  };
  // A barline reaches from the top line of the first staff to the bottom line of the last, except at a one-line
  // percussion staff, where it runs a space either side of the line instead of the five-line staff's whole height.
  const firstStaff = staves[span.firstStaff];
  const lastStaff = staves[span.lastStaff];
  const joinTop = firstStaff?.type === 'percussion' && firstStaff.drumKit !== true ? firstStaff.staveY + units(1) : span.y;
  const joinBottom = lastStaff?.type === 'percussion' && lastStaff.drumKit !== true ? lastStaff.staveY + units(3) : span.y + span.height;
  const join: BarlineJoin = {
    y: joinTop,
    height: joinBottom - joinTop,
    staveYs: staves.map((staff) => staff.staveY),
  };
  const opensOnRepeat = system.bars[0]?.items.some((item) => item.kind === 'barline') ?? false;

  const shading: SvgElement[] = [];
  const barInk: SvgElement[] = [];
  const barlineInk: SvgElement[] = [];
  const anchorsByStaff: NoteAnchors[] = staves.map(() => new Map());

  // Barlines run through every staff in one piece, drawn once from the top staff's bar items.
  for (const bar of system.bars) {
    for (const item of bar.items) {
      if (item.kind === 'barline') {
        barlineInk.push(...startBarline(font, item.barline, bar.x + bar.prefixWidth, system.staveY, join));
      } else if (item.kind === 'endBarline') {
        barlineInk.push(...endBarline(font, item.barline, bar.x + bar.width, system.staveY, join));
      }
    }
  }

  for (const [barIndex, bar] of system.bars.entries()) {
    for (const staff of staves) {
      const staffBar = staff.bars[barIndex];
      if (staffBar === undefined) continue;
      const anchors = anchorsByStaff[staff.index];
      if (anchors === undefined) continue;
      const percussion = staff.type === 'percussion';
      // The clef in force over this bar: the staff's opening one unless a change has come (SIB2-241).
      const barClef = staffBar.clef ?? staff.clef;
      const flips = percussion ? new Set<Id>() : stemFlips(staffBar.voices);
      const merges = percussion ? new Map<Id, StemMerge>() : stemMerges(staffBar.voices, barClef, flips);
      for (const [voiceIndex, voice] of staffBar.voices.entries()) {
        const first = voiceIndex === 0;
        const mode: BarMode = {
          staveY: staff.staveY,
          clef: barClef,
          percussion,
          drumKit: staff.drumKit === true,
          chrome: staff.index === 0 && first,
          prefix: first,
          barlines: false,
          aligned: true,
          stems: staff.drumKit === true ? (voice.stems === 'auto' ? 'up' : voice.stems) : stemsOf(voice, staffBar.voices),
          // A kit's feet voice keeps its rests below the staff's snare and tom places, out of the hands' way.
          restShift:
            staff.drumKit === true && staffBar.voices.length > 1
              ? voice.stems === 'down'
                ? KIT_FEET_REST_SHIFT
                : restShiftOf(voice, staffBar.voices)
              : restShiftOf(voice, staffBar.voices),
          shifts: noteShifts(font, { voice, voices: staffBar.voices, clef: barClef, flips, merges }),
          flips,
          merges,
          lowFermatas: true,
          centreWholeRest: voicesWithMusic(staffBar.voices) < 2,
        };
        // The staff's bar as the single-staff engraver knows it: this voice's items in the bar's box.
        // A drum kit's second pair of voices (3, 4) hold only the hits that share a moment with voices 1 and 2; their
        // filler rests are not drawn, the way a drum chart leaves them out.
        const items = staff.drumKit === true && voice.index > 2 ? voice.items.filter((item) => item.kind !== 'rest') : voice.items;
        const layoutBar: LayoutBar = { ...bar, items };
        barInk.push(...engraveBar(font, layoutBar, system, time, options, bands, anchors, shading, skipped, mode));
      }
    }
  }

  const children: SvgElement[] = [...shading];
  if (options.staffLines) {
    for (const staff of staves) {
      // A tab staff is drawn as five lines for now (the six-line staff and its fret numbers are a later slice).
      children.push(
        ...staffLines(font, { x: system.x, width: system.width, staveY: staff.staveY }, staff.type === 'percussion' && staff.drumKit !== true),
      );
    }
    if (!opensOnRepeat) children.push(openingBarline(font, system.x, system.staveY, join));
    children.push(...staffGroups(groups));
  }
  children.push(...barlineInk, ...barInk);

  // Where this system's music begins, as the single-staff path does: past the clef and key signature.
  const opening = system.bars[0];
  const musicLeft = opening === undefined ? system.x : opening.x + opening.prefixWidth;
  const systemRight = system.x + system.width;

  // Ties and slurs belong to a staff: a tie to the staff of its notes, a slur to the staff of its first note, with only
  // that staff's notes under the curve for clearance. Every curve is drawn after all the ink, as on one staff.
  for (const staff of staves) {
    const anchors = anchorsByStaff[staff.index] ?? new Map();
    for (const layoutTie of staff.ties) {
      const curve = tie(font, {
        from: layoutTie.fromNoteId === null ? null : (anchors.get(layoutTie.fromNoteId) ?? null),
        to: layoutTie.toNoteId === null ? null : (anchors.get(layoutTie.toNoteId) ?? null),
        systemLeft: musicLeft,
        systemRight,
      });
      if (curve !== null) children.push(curve);
    }
  }
  for (const layoutSlur of system.slurs) {
    const owner = anchorsByStaff.find(
      (anchors) =>
        (layoutSlur.fromNoteId !== null && anchors.has(layoutSlur.fromNoteId)) ||
        (layoutSlur.toNoteId !== null && anchors.has(layoutSlur.toNoteId)),
    );
    if (owner === undefined) continue;
    const staffIndex = anchorsByStaff.indexOf(owner);
    const from = layoutSlur.fromNoteId === null ? null : (owner.get(layoutSlur.fromNoteId) ?? null);
    const to = layoutSlur.toNoteId === null ? null : (owner.get(layoutSlur.toNoteId) ?? null);
    const lowest = Math.min(from?.x ?? musicLeft, to?.x ?? musicLeft);
    const highest = Math.max(from?.x ?? systemRight, to?.x ?? systemRight);
    const under = [...owner.values()].filter((end) => end.x >= lowest && end.x <= highest);
    const curve = slur(font, {
      from,
      to,
      under,
      placement: layoutSlur.placement,
      systemLeft: musicLeft,
      systemRight,
      // Above the top staff a slur stays under the chord row; between staves there is the gap to arch in.
      ceiling: staffIndex === 0 ? bands.chordBaseline : (staves[staffIndex]?.staveY ?? 0) - units(2),
    });
    if (curve !== null) children.push(curve);
  }

  // Ottava lines (SIB2-184) ride on the staff of their first note: layout reserved the height above and below that
  // staff, the top one's in the system and the others' on the staff itself (SIB2-233).
  for (const line of system.ottavas) {
    const staffIndex = line.staff ?? 0;
    const staff = staves[staffIndex];
    if (staff === undefined) continue;
    const anchors = anchorsByStaff[staffIndex] ?? new Map();
    const aboveOffset = staffIndex === 0 ? system.ottavaAboveOffset : staff.ottavaAboveOffset;
    const belowOffset = staffIndex === 0 ? system.ottavaBelowOffset : staff.ottavaBelowOffset;
    const y =
      line.shift === 'up'
        ? aboveOffset === undefined
          ? undefined
          : staff.staveY - aboveOffset
        : belowOffset === undefined
          ? undefined
          : staff.staveY + units(4) + belowOffset;
    if (y === undefined) continue;
    const from = line.fromNoteId === null ? undefined : anchors.get(line.fromNoteId);
    const to = line.toNoteId === null ? undefined : anchors.get(line.toNoteId);
    children.push(
      ...ottavaLine({
        shift: line.shift,
        from: from === undefined ? musicLeft : from.x,
        to: to === undefined ? systemRight : to.x + to.noteheadWidth,
        y,
        labelled: line.labelled,
        hooked: line.toNoteId !== null,
        size: options.chordFontSize * 0.9,
      }),
    );
  }

  return children;
}

// ---------------------------------------------------------------------------
// A bar
// ---------------------------------------------------------------------------

/** One note or rest, with its geometry settled but nothing emitted yet. */
interface EngravedNote {
  item: NoteItem | RestItem;
  x: number;
  /** Where the accidental goes when the head was moved aside for another voice's (slice 4). */
  accidentalX?: number;
  position: number;
  glyph: MusicGlyphName;
  levels: number;
  /** Null for a whole note and for every rest. */
  stem: Stem | null;
}

/**
 * What one call of `engraveBar` is drawing (ADR-0041, slice 4). A single-staff chart is one call with `SINGLE_STAFF`,
 * which is every field at the value the engraver always had, so its output is the bytes it always was. A multi-staff
 * system is one call per voice of every staff: the first voice of each staff carries that staff's clef, key and time
 * signature, the top staff's first voice alone carries the chord row, text and bar number, and every voice draws its own
 * notes, rests, beams and tuplets.
 */
interface BarMode {
  /** The y of this staff's top line. */
  staveY: number;
  clef: Clef;
  /** A percussion staff: x noteheads, every note on its one line, stems up unless a voice says otherwise. */
  percussion: boolean;
  /** A drum kit (slice 6): five lines, each note at its drum's place with its drum's head. */
  drumKit: boolean;
  /** Bar number, tempo, rehearsal mark, endings, chord symbols, text and the invalid-bar wash: the top staff's. */
  chrome: boolean;
  /** The clef, key signature and time signature at the head of the bar. */
  prefix: boolean;
  /** This bar's own barlines; off on a multi-staff system, whose barlines run through every staff in one piece. */
  barlines: boolean;
  /** Notes sit on layout's shared columns (`item.x`) rather than being spaced here. */
  aligned: boolean;
  /** `up`/`down` once the staff-bar has two voices with music. */
  stems: 'up' | 'down' | 'auto';
  /** Half-spaces to move this voice's rests: up for the upper voice, down for the lower. */
  restShift: number;
  /** Noteheads moved aside for another voice's. */
  shifts: ReadonlyMap<Id, VoiceShift>;
  /** Notes whose numbered stem turns the other way where their voice crosses another's (SIB2-233). */
  flips?: ReadonlySet<Id>;
  /** A staved system hangs a fermata under a stem-down voice's note and under a note below the staff (SIB2-233). */
  lowFermatas?: boolean;
  /** Voice-3 notes sharing voice 1's stem: the one that does not own it draws none (SIB2-233). */
  merges?: ReadonlyMap<Id, StemMerge>;
  /** A bar whose one voice holds a whole-bar rest centres it; a rest in a two-voice bar does not. */
  centreWholeRest: boolean;
}

/** Half spaces a drum kit's down-stem voice moves its rests: past the two a pitched lower voice moves them. */
const KIT_FEET_REST_SHIFT = 4;

const SINGLE_STAFF = (staveY: number): BarMode => ({
  staveY,
  clef: 'treble',
  percussion: false,
  drumKit: false,
  chrome: true,
  prefix: true,
  barlines: true,
  aligned: false,
  stems: 'auto',
  restShift: 0,
  shifts: new Map(),
  centreWholeRest: true,
});

function engraveBar(
  font: MusicFont,
  bar: LayoutBar,
  system: LayoutSystem,
  time: TimeSignature,
  options: EngraveOptions,
  bands: Bands,
  anchors: NoteAnchors,
  shading: SvgElement[],
  skipped: Map<LayoutBarItemKind, number>,
  mode: BarMode = SINGLE_STAFF(system.staveY),
): SvgElement[] {
  const staveY = mode.staveY;
  const before: SvgElement[] = [];
  const after: SvgElement[] = [];

  // A bar whose rhythm does not fill the meter gets a wash under its whole box (ADR-0013).
  // The metric verdict is layout's, carried on `bar.metrics`, never re-derived here. It goes
  // in first so a flagged object's own stripe reads on top of it (V14c).
  if (mode.chrome && !bar.metrics.valid) shading.push(invalidBarShade(bar.x, bar.width, staveY));

  // The prefix is drawn inside the room layout allocated for it, left to right.
  let prefixX = bar.x + units(0.6);

  const chords: {
    /** The x layout gave it, on a multi-staff system, where every column is shared across staves. */
    x?: number;
    anchorItemId: Id | null;
    onset: number;
    text: string;
    plain: boolean;
    flagged: boolean;
    /** A text direction's dashed line, drawn after the text (SIB2-170). */
    line?: { endsHere: boolean };
  }[] = [];
  /** Dashed-line segments that start at the bar's left edge: a direction from an earlier bar passing through. */
  const lineSegments: { endsHere: boolean }[] = [];
  const tuplets: { actual: number; memberIds: Id[] }[] = [];
  const endings: EndingItem[] = [];
  let hasRehearsalMark = false;
  let rehearsalRight: number | null = null;

  for (const item of bar.items) {
    switch (item.kind) {
      case 'clef':
        if (!mode.prefix) break;
        if (item.change === true) {
          // A change of clef: small, in the lead-in, after which the bar's own clef is the new one (SIB2-241).
          before.push(clef(font, prefixX, staveY, item.clef, CLEF_CHANGE_SIZE));
          prefixX += clefWidth(font, item.clef) * CLEF_CHANGE_SIZE + units(0.4);
          break;
        }
        before.push(clef(font, prefixX, staveY, item.clef));
        prefixX += clefWidth(font, item.clef) + units(0.4);
        break;

      case 'keySignature': {
        if (!mode.prefix) break;
        const drawn = keySignature(font, item.fifths, prefixX, staveY, mode.clef);
        before.push(...drawn.elements);
        prefixX += drawn.width + units(0.4);
        break;
      }

      case 'timeSignature': {
        if (!mode.prefix) break;
        const drawn = timeSignature(font, item.time, prefixX, staveY);
        before.push(...drawn.elements);
        prefixX += drawn.width;
        break;
      }

      case 'barNumber':
        if (!mode.chrome) break;
        before.push(
          text({
            text: item.text,
            x: bar.x + units(0.2),
            y: staveY - units(0.8),
            size: options.barNumberFontSize,
            align: 'left',
            class: 'se-barnumber',
          }),
        );
        break;

      case 'tempo': {
        if (!mode.chrome) break;
        hasRehearsalMark = true;
        // After the clef, key and time signature, and clear of a rehearsal box on the same bar.
        const afterBox = rehearsalRight === null ? 0 : rehearsalRight - bar.x + units(1);
        before.push(
          ...tempoMark(
            font,
            item,
            bar.x + Math.max(bar.prefixWidth + units(0.5), afterBox),
            bands.markTop,
            options.rehearsalFontSize,
          ),
        );
        break;
      }

      case 'rehearsalMark': {
        if (!mode.chrome) break;
        hasRehearsalMark = true;
        // The top of the band, not a baseline: the box's own padding is the adapter's
        // to allow for, and layout reserved the band from `bands.top` down.
        if (item.text !== '') {
          before.push(...rehearsalMark(item.text, bar.x, bands.markTop, options.rehearsalFontSize));
        }
        // The section's name (SIB2-176) is boxed beside the letter, or alone when it has no letter.
        const letterWidth =
          item.text === '' ? 0 : rehearsalBoxWidth(item.text, options.rehearsalFontSize) + options.rehearsalFontSize * 0.4;
        // Where the boxes end, so a tempo mark on the same bar starts clear of them.
        rehearsalRight =
          bar.x +
          letterWidth +
          (item.name === undefined ? 0 : rehearsalBoxWidth(item.name, options.rehearsalFontSize));
        if (item.name !== undefined) {
          before.push(
            ...rehearsalMark(
              item.name,
              bar.x + letterWidth,
              bands.markTop,
              options.rehearsalFontSize,
              'se-sectionnamebox',
              'se-sectionname',
            ),
          );
        }
        break;
      }

      case 'barline':
        // After the clef and key signature, not before them: a repeat sign belongs to
        // the music, and the prefix belongs to the system.
        if (!mode.barlines) break;
        before.push(...startBarline(font, item.barline, bar.x + bar.prefixWidth, staveY));
        break;

      case 'endBarline':
        if (!mode.barlines) break;
        after.push(...endBarline(font, item.barline, bar.x + bar.width, staveY));
        break;

      case 'nav':
        if (!mode.chrome) break;
        before.push(
          ...navMark(font, {
            kind: item.nav,
            start: bar.x + bar.prefixWidth + units(0.6),
            end: bar.x + bar.width - units(0.6),
            top: bands.top,
            fontSize: options.chordFontSize,
          }),
        );
        break;

      case 'ending':
        if (!mode.chrome) break;
        endings.push(item);
        break;

      case 'chordSymbol':
        if (!mode.chrome) break;
        chords.push({
          ...(item.x === undefined ? {} : { x: item.x }),
          anchorItemId: item.anchorItemId,
          onset: item.onset,
          text: item.text,
          plain: false,
          flagged: item.flagged,
        });
        break;

      case 'annotation':
        if (!mode.chrome) break;
        chords.push({
          ...(item.x === undefined ? {} : { x: item.x }),
          anchorItemId: item.anchorItemId,
          onset: item.onset,
          text: item.text,
          plain: true,
          flagged: item.flagged,
          ...(item.line === undefined ? {} : { line: item.line }),
        });
        break;

      case 'directionLine':
        if (!mode.chrome) break;
        lineSegments.push({ endsHere: item.endsHere });
        break;

      case 'tupletBracket':
        tuplets.push({ actual: item.actual, memberIds: item.memberIds });
        break;

      case 'note':
      case 'rest':
        // Placed together below, because where each one goes depends on all of them.
        break;

      default:
        return exhausted(item);
    }
  }

  const placed = mode.aligned ? placeAligned(font, bar, mode.centreWholeRest) : placeItems(font, bar);
  // A head moved aside for another voice's keeps its accidental where the head would have been (slice 4).
  for (const entry of placed) {
    const shift = entry.item.kind === 'note' ? mode.shifts.get(entry.item.noteId) : undefined;
    if (shift === undefined) continue;
    entry.accidentalX = entry.x;
    entry.x += shift.dx;
  }
  const groups = beamGroups(placed, time);
  const beamed = new Set<PlacedItem>(groups.flat());

  // The direction every stem on this staff-bar is forced to: a numbered voice's, or up on a percussion staff.
  const forced: StemDirection | null = mode.stems === 'auto' ? (mode.percussion ? 'up' : null) : mode.stems;
  const where: ItemContext = { clef: mode.clef, percussion: mode.percussion, drumKit: mode.drumKit, restShift: mode.restShift };

  const notes = new Map<PlacedItem, EngravedNote>();
  for (const entry of placed) {
    // A crossing turns this note's stem away from the other voice's (SIB2-233); only a staved bar has any.
    const turned = entry.item.kind === 'note' && mode.flips?.has(entry.item.noteId) === true && forced !== null;
    const engraved = engraveItem(font, entry, staveY, turned ? (forced === 'up' ? 'down' : 'up') : forced, where);
    notes.set(entry, entry.item.kind === 'note' ? mergedStem(font, engraved, mode.merges?.get(entry.item.noteId), staveY) : engraved);
  }

  // A beamed group takes one stem direction, so its members' stems are rebuilt from the
  // group's decision before the beam is fitted to them.
  const beams: SvgElement[] = [];
  const beamedIds = new Set<Id>();
  for (const group of groups) {
    const members: BeamMember[] = [];
    const direction = forced ?? groupStemDirection(group.map((entry) => notes.get(entry)?.position ?? 0));
    const breaks = secondaryBreaks(group.map((entry) => entry.item.onset), time);
    for (const [at, entry] of group.entries()) {
      const rebuilt = engraveItem(font, entry, staveY, direction, where);
      notes.set(entry, rebuilt);
      if (entry.item.kind === 'note') beamedIds.add(entry.item.noteId);
      if (rebuilt.stem !== null) {
        members.push({
          stem: rebuilt.stem,
          position: rebuilt.position,
          levels: rebuilt.levels,
          breakBefore: breaks[at] === true,
        });
      }
    }
    if (members.length < 2) continue;
    const line = beamLine(members);
    applyBeam(line, members);
    beams.push(...beamElements(font, line, members));
  }

  const ink: SvgElement[] = [];
  const byItemId = new Map<Id, EngravedNote>();
  for (const entry of placed) {
    const note = notes.get(entry);
    if (note === undefined) continue;
    byItemId.set(entry.item.kind === 'note' ? entry.item.noteId : entry.item.restId, note);
    if (entry.item.kind === 'note') {
      anchors.set(entry.item.noteId, {
        x: note.x,
        noteheadWidth: font.width(note.glyph),
        y: positionY(note.position, staveY),
        stem: note.stem?.direction ?? null,
        stemTipY: note.stem?.endY ?? null,
        stemX: note.stem?.centre ?? null,
      });
    }
    // A note or rest the recogniser was unsure of gets a stripe down its column (ADR-0019),
    // sized from the notehead's own box rather than a measurement (ADR-0015).
    if (entry.item.flagged) shading.push(flaggedItemShade(note.x, font.width(note.glyph), staveY));
    ink.push(...noteInk(font, note, staveY, beamed.has(entry)));
    if (entry.item.kind === 'note' && entry.item.graces !== undefined && entry.graceXs !== undefined) {
      ink.push(...graceInk(font, entry.item.graces, entry.graceXs, entry.item.ottava, staveY));
    }
    if (entry.item.kind === 'note' && entry.item.articulations !== undefined && entry.item.articulations.length > 0) {
      ink.push(
        ...articulations(font, {
          x: note.x,
          width: font.width(note.glyph),
          y: positionY(note.position, staveY),
          staveY,
          stem: note.stem?.direction ?? forced ?? stemDirection(note.position),
          marks: entry.item.articulations,
        }),
      );
    }
    if (entry.item.fermata === true) {
      const headTop = positionY(note.position, staveY) - units(0.5);
      const up = note.stem !== null && note.stem.direction === 'up';
      // Under the note, not across the staff from it, for a stem-down voice or a head below the bottom line (SIB2-233).
      const under = mode.lowFermatas === true && entry.item.kind === 'note' && (mode.stems === 'down' || note.position > 8);
      if (under) {
        const headBottom = positionY(note.position, staveY) + units(0.5);
        const marks = (entry.item.kind === 'note' ? (entry.item.articulations?.length ?? 0) : 0) * ARTICULATION_BAND;
        ink.push(
          fermataBelow(font, {
            x: note.x,
            width: font.width(note.glyph),
            staveY,
            inkBottomY: (note.stem !== null && !up ? Math.max(headBottom, note.stem.endY) : headBottom) + (up ? marks : 0),
          }),
        );
        continue;
      }
      ink.push(
        fermata(font, {
          x: note.x,
          width: font.width(note.glyph),
          staveY,
          inkTopY:
            entry.item.kind === 'rest'
              ? null
              : (up && note.stem !== null ? Math.min(headTop, note.stem.endY) : headTop) -
                // Marks over a down-stemmed head push the fermata up past them (SIB2-179).
                (up ? 0 : (entry.item.articulations?.length ?? 0) * ARTICULATION_BAND),
        }),
      );
    }
  }

  for (const spec of tuplets) {
    const members = spec.memberIds
      .map((id) => byItemId.get(id))
      .filter((note): note is EngravedNote => note !== undefined);
    const bracket = tupletBracket(font, members, spec.actual, beamedIds, staveY, forced);
    if (bracket !== null) after.push(...bracket);
  }

  // Both a rehearsal letter and an ending bracket want the top of the band. They share
  // it happily until one bar carries both, which is a section that begins on a first
  // ending — so that bar, and only that bar, drops its bracket clear of the box.
  for (const item of endings) {
    before.push(
      ...ending(font, {
        numbers: item.numbers,
        role: item.role,
        x: bar.x,
        right: bar.x + bar.width,
        y: bands.markTop + (hasRehearsalMark ? options.rehearsalFontSize * 2.2 : units(0.4)),
        fontSize: options.endingFontSize,
      }),
    );
  }

  // A chord sits at its beat, not just at the nearest note: when no item starts on its onset it is
  // interpolated across the anchor's span, so two chords over one half note or a whole rest read as
  // two (SIB2-165). Symbols that still touch are pushed right, never left over their own beat.
  const chordXs = chordPositions(chords, placed, bar, options.chordFontSize, options.chordStyle, mode.aligned);
  for (const [index, chord] of chords.entries()) {
    const x = chordXs[index] ?? bar.x + bar.prefixWidth + units(1);
    // A flagged chord symbol or annotation gets a wash behind it (ADR-0019). Its box is
    // estimated from the character count, never measured (ADR-0015).
    if (chord.flagged) {
      shading.push(flaggedChordShade(x, chord.text.length, bands.chordBaseline, options.chordFontSize));
    }
    before.push(
      chordSymbol({
        text: chord.text,
        x,
        y: bands.chordBaseline,
        size: options.chordFontSize,
        plain: chord.plain,
        style: options.chordStyle,
        family: options.textFont,
      }),
    );
  }

  // Dashed continuation lines after text directions (SIB2-170), above the chord row, so it never strikes through a chord: from the end of the text
  // (this bar) or the bar's left edge (a later bar) to its right edge, with a hook down at a closing bar's end.
  const lineY = bands.chordBaseline - options.chordFontSize * 1.1;
  for (const [index, chord] of chords.entries()) {
    if (chord.line === undefined) continue;
    const x = chordXs[index] ?? bar.x + bar.prefixWidth + units(1);
    const from = x + options.chordFontSize * CHORD_ADVANCE_EM * chord.text.length + units(0.6);
    before.push(...directionLine(from, bar.x + bar.width, lineY, chord.line.endsHere, options.chordFontSize));
  }
  for (const segment of lineSegments) {
    before.push(
      ...directionLine(bar.x + bar.prefixWidth, bar.x + bar.width, lineY, segment.endsHere, options.chordFontSize),
    );
  }

  void skipped;
  return [...before, ...ink, ...beams, ...after];
}

/**
 * A dashed line from `from` to `to`; a closing bar stops a little short of its barline and ends in a hook down
 * toward the staff, so a reader sees where the instruction stops.
 */
function directionLine(from: number, to: number, y: number, closes: boolean, size: number): SvgElement[] {
  const end = closes ? to - units(0.6) : to;
  if (end <= from) return [];
  const out: SvgElement[] = [
    el('path', {
      class: 'se-directionline',
      d: `M${from} ${y}L${end} ${y}`,
      fill: 'none',
      stroke: '#000000',
      'stroke-width': 1,
      'stroke-dasharray': `${size * 0.4} ${size * 0.3}`,
    }),
  ];
  if (closes) {
    out.push(
      el('path', {
        class: 'se-directionhook',
        d: `M${end} ${y}L${end} ${y + size * 0.8}`,
        fill: 'none',
        stroke: '#000000',
        'stroke-width': 1,
      }),
    );
  }
  return out;
}

/** Estimated advance of a chord symbol, as in `flaggedChordShade` — never measured (ADR-0015). */
const CHORD_ADVANCE_EM = 0.6;
const CHORD_GAP_EM = 0.5;

function chordPositions(
  chords: { x?: number; anchorItemId: Id | null; onset: number; text: string; plain: boolean }[],
  placed: PlacedItem[],
  bar: LayoutBar,
  size: number,
  style: ChordStyle,
  aligned = false,
): number[] {
  const fallback = bar.x + bar.prefixWidth + units(1);
  const right = bar.x + bar.width - units(1);
  const xs = chords.map((chord) => {
    // On a multi-staff system layout has already put the chord on its column, shared with every staff's notes.
    if (aligned && chord.x !== undefined) return chord.x;
    const anchorIndex = placed.findIndex((entry) => {
      const id = entry.item.kind === 'note' ? entry.item.noteId : entry.item.restId;
      return id === chord.anchorItemId;
    });
    const anchor = placed[anchorIndex];
    if (anchor === undefined) return fallback;
    if (chord.onset <= anchor.item.onset) return anchor.slotX;
    const next = placed[anchorIndex + 1];
    const spanEnd = next === undefined ? anchor.item.onset + durationTicks(anchor.item.duration) : next.item.onset;
    const endX = next === undefined ? right : next.slotX;
    const fraction = Math.min((chord.onset - anchor.item.onset) / (spanEnd - anchor.item.onset), 1);
    return anchor.slotX + fraction * (endX - anchor.slotX);
  });

  // Push apart in onset order; the array is returned in the original order. The width is of what is
  // drawn (`EbΔ7(♯11)`, not `Ebmaj7#11`), because a raised extension adds glyphs the source text lacks
  // (SIB2-153: `A7b9` drew six glyphs against four estimated and touched the next chord).
  const widthOf = (chord: { text: string; plain: boolean }): number =>
    size * CHORD_ADVANCE_EM * (chord.plain ? chord.text.length : chordGlyphText(chord.text, style).length);
  const gap = size * CHORD_GAP_EM;
  const order = chords.map((_, i) => i).sort((a, b) => (chords[a]?.onset ?? 0) - (chords[b]?.onset ?? 0));
  let edge = Number.NEGATIVE_INFINITY;
  for (const i of order) {
    const chord = chords[i];
    if (chord === undefined) continue;
    const x = Math.max(xs[i] ?? fallback, edge);
    xs[i] = x;
    edge = x + widthOf(chord) + gap;
  }

  // The last symbol must not run out of its bar into the next bar's first chord: if the forward pass
  // pushed it past the barline, pull the run back left, as far as the bar's own left edge allows.
  let limit = right;
  for (const i of [...order].reverse()) {
    const chord = chords[i];
    if (chord === undefined) continue;
    const x = Math.min(xs[i] ?? fallback, limit - widthOf(chord));
    xs[i] = Math.max(x, fallback);
    limit = x - gap;
  }
  // Pulling left can break the left bound for early symbols; one more forward pass restores order.
  edge = Number.NEGATIVE_INFINITY;
  for (const i of order) {
    const chord = chords[i];
    if (chord === undefined) continue;
    xs[i] = Math.max(xs[i] ?? fallback, edge);
    edge = (xs[i] ?? fallback) + widthOf(chord) + gap;
  }
  return xs;
}

/** What a staff adds to where a note or rest sits: its clef, whether it is unpitched, and a voice's rest offset. */
interface ItemContext {
  clef: Clef;
  percussion: boolean;
  drumKit: boolean;
  restShift: number;
}

const TREBLE_ITEMS: ItemContext = { clef: 'treble', percussion: false, drumKit: false, restShift: 0 };

function engraveItem(
  font: MusicFont,
  entry: PlacedItem,
  staveY: number,
  direction: StemDirection | null,
  context: ItemContext = TREBLE_ITEMS,
): EngravedNote {
  const { item } = entry;

  if (item.kind === 'rest') {
    return {
      item,
      x: entry.x,
      position: restPosition(item.duration) + context.restShift,
      glyph: restFor(item.duration),
      levels: 0,
      stem: null,
    };
  }

  const glyph = context.drumKit
    ? drumNoteheadFor(item.duration, headOf(item))
    : context.percussion
      ? percussionNoteheadFor(item.duration)
      : noteheadFor(item.duration);
  // A drum kit's pitches are display pitches, counted as treble (`drums.ts`): the staff's clef is the percussion clef.
  const position =
    context.clef === 'treble' || context.drumKit
      ? staffPosition(writtenPitch(item.pitch, item.ottava))
      : staffPositionIn(writtenPitch(item.pitch, item.ottava), context.clef);
  return {
    item,
    x: entry.x,
    ...(entry.accidentalX === undefined ? {} : { accidentalX: entry.accidentalX }),
    position,
    glyph,
    levels: beamCount(item.duration),
    stem: hasStem(item.duration)
      ? stem(font, {
          notehead: glyph,
          direction: direction ?? stemDirection(position),
          noteX: entry.x,
          position,
          staveY,
        })
      : null,
  };
}

/**
 * A voice-3 note on voice 1's stem (`stemMerges`): the head that does not own the stem draws none, and the owner's runs up
 * past the other head as well, so the two read as one chord (SIB2-233).
 */
function mergedStem(font: MusicFont, note: EngravedNote, merge: StemMerge | undefined, staveY: number): EngravedNote {
  if (merge === undefined || note.stem === null) return note;
  if (!merge.owns) return { ...note, stem: null };
  const other = stem(font, { notehead: note.glyph, direction: note.stem.direction, noteX: note.x, position: merge.reach, staveY });
  return { ...note, stem: { ...note.stem, endY: Math.min(note.stem.endY, other.endY) } };
}

function noteInk(
  font: MusicFont,
  note: EngravedNote,
  staveY: number,
  isBeamed: boolean,
): SvgElement[] {
  const elements: SvgElement[] = [];
  const y = positionY(note.position, staveY);

  if (note.item.kind === 'note') {
    elements.push(
      ...ledgerLines(font, {
        noteX: note.x,
        noteheadWidth: font.width(note.glyph),
        position: note.position,
        staveY,
      }),
    );

    if (note.item.accidentalGlyph !== null) {
      // Spacing already reserved exactly this much room to the left of the notehead, so
      // the accidental lands in it rather than on top of whatever came before.
      const glyph = accidentalGlyph(note.item.accidentalGlyph);
      const headX = note.accidentalX ?? note.x;
      if (note.item.accidental === 'parens') {
        // A cautionary accidental (SIB2-182): the accidental between two SMuFL brackets, the pair
        // sitting in the room spacing reserved (`parensWidth`).
        const right = headX - ACCIDENTAL_GAP - font.width('accidentalParensRight');
        const glyphX = right - font.width(glyph);
        elements.push(font.element('accidentalParensRight', right, y));
        elements.push(font.element(glyph, glyphX, y));
        elements.push(font.element('accidentalParensLeft', glyphX - font.width('accidentalParensLeft'), y));
      } else {
        elements.push(font.element(glyph, headX - ACCIDENTAL_GAP - font.width(glyph), y));
      }
    }
  }

  elements.push(font.element(note.glyph, note.x, y));

  for (const dot of dotPositions(
    font,
    note.item.duration,
    note.glyph,
    note.x,
    note.position,
    staveY,
  )) {
    elements.push(font.element('augmentationDot', dot.x, dot.y));
  }

  if (note.stem !== null) {
    elements.push(stemElement(note.stem));
    if (!isBeamed) {
      const flag = flagFor(note.item.duration, note.stem.direction);
      if (flag !== null) {
        const origin = flagOrigin(font, flag, note.stem);
        elements.push(font.element(flag, origin.x, origin.y));
      }
    }
  }

  return elements;
}

// ---------------------------------------------------------------------------
// Tuplets
// ---------------------------------------------------------------------------

function tupletBracket(
  font: MusicFont,
  members: readonly EngravedNote[],
  actual: number,
  beamedIds: ReadonlySet<Id>,
  staveY: number,
  forced: StemDirection | null = null,
): SvgElement[] | null {
  const first = members[0];
  const last = members[members.length - 1];
  if (first === undefined || last === undefined) return null;

  const direction = forced ?? groupStemDirection(members.map((member) => member.position));
  const away = direction === 'up' ? -1 : 1;

  // The extreme the group's ink reaches on the bracket's side: a stem end, or a notehead
  // for anything unstemmed.
  let extentY = positionY(first.position, staveY);
  for (const member of members) {
    const edge = member.stem?.endY ?? positionY(member.position, staveY);
    extentY = away === -1 ? Math.min(extentY, edge) : Math.max(extentY, edge);
  }

  const beamedThroughout = members.every(
    (member) => member.item.kind === 'note' && beamedIds.has(member.item.noteId),
  );

  return tuplet(font, {
    actual,
    left: first.x,
    right: last.x + font.width(last.glyph),
    extentY,
    direction,
    beamed: beamedThroughout,
  });
}

// ---------------------------------------------------------------------------
// Beam grouping
// ---------------------------------------------------------------------------

/** The grouping rules live in `beam-groups.ts`; this maps placed items onto them and back. */
function beamGroups(placed: readonly PlacedItem[], time: TimeSignature): PlacedItem[][] {
  const candidates: BeamCandidate[] = placed.map(({ item }) => ({
    kind: item.kind,
    onset: item.onset,
    beamable: item.kind === 'note' && beamCount(item.duration) > 0,
    plainEighth: item.duration.value === 8 && item.duration.dots === 0,
    tupletId: item.tupletId,
  }));
  return beamGroupIndices(candidates, time).map((indices) =>
    indices.flatMap((index) => placed[index] ?? []),
  );
}

/** Makes an unhandled item kind a compile error, not a silently dropped glyph. */
function exhausted(item: never): never {
  throw new Error(`unhandled layout item kind: ${JSON.stringify(item)}`);
}
