import type {
  EndingItem,
  LayoutBar,
  LayoutBarItemKind,
  LayoutResult,
  LayoutSystem,
  NoteItem,
  RestItem,
} from '@sibei/layout';
import { LAYOUT_BAR_ITEM_KINDS } from '@sibei/layout';
import type { Id, TimeSignature } from '@sibei/model';
import { TICKS_PER_WHOLE, beatTicks } from '@sibei/model';
import { endBarline, ending, openingBarline, startBarline } from './barlines.js';
import type { BeamMember } from './beams.js';
import { applyBeam, beamElements, beamLine } from './beams.js';
import type { MusicFont, MusicGlyphName } from './font.js';
import { units } from './font.js';
import type { MusicFontName } from './fonts/index.js';
import { DEFAULT_MUSIC_FONT, musicFontNamed } from './fonts/index.js';
import { restFor, restPosition } from './rests.js';
import { clef, keySignature, timeSignature } from './signatures.js';
import type { PlacedItem } from './spacing.js';
import { ACCIDENTAL_GAP, accidentalGlyph, placeItems } from './spacing.js';
import { ledgerLines, positionY, staffLines, staffPosition } from './staff.js';
import type { Stem, StemDirection } from './stems.js';
import {
  beamCount,
  dotPositions,
  flagFor,
  flagOrigin,
  groupStemDirection,
  hasStem,
  noteheadFor,
  stem,
  stemDirection,
  stemElement,
} from './stems.js';
import type { SvgElement } from './svg.js';
import { el, serialise } from './svg.js';
import type { TieEnd } from './ties.js';
import { tie } from './ties.js';
import { chordSymbol, headerText, rehearsalMark, text } from './text.js';
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
}

const DEFAULT_OPTIONS: EngraveOptions = {
  font: DEFAULT_MUSIC_FONT,
  staffLines: true,
  chordFontSize: 14,
  barNumberFontSize: 11,
  rehearsalFontSize: 13,
  endingFontSize: 11,
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
  const page = result.pages[pageIndex];
  if (page === undefined) throw new Error(`no such page: ${pageIndex}`);

  const font = musicFontNamed(opts.font);
  const skipped = new Map<LayoutBarItemKind, number>();
  const children: SvgElement[] = page.header.map(headerText);

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
  // Only the head of a system gets an opening line: elsewhere the previous bar's closing
  // barline is the junction, and two lines at one x would double it up. A system that
  // opens on a repeat already has its own thick line there, and would double it the same
  // way — visible immediately in the proof of bar 12.
  const opensOnRepeat = system.bars[0]?.items.some((item) => item.kind === 'barline') ?? false;

  const children: SvgElement[] = [];
  if (options.staffLines) {
    children.push(...staffLines(font, { x: system.x, width: system.width, staveY: system.staveY }));
    if (!opensOnRepeat) children.push(openingBarline(font, system.x, system.staveY));
  }

  const bands: Bands = {
    top: system.staveY - system.aboveStaff,
    chordBaseline: system.staveY - system.chordBaselineOffset,
  };

  const anchors: NoteAnchors = new Map();
  for (const bar of system.bars) {
    children.push(...engraveBar(font, bar, system, time, options, bands, anchors, skipped));
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

  return children;
}

// ---------------------------------------------------------------------------
// A bar
// ---------------------------------------------------------------------------

/** One note or rest, with its geometry settled but nothing emitted yet. */
interface EngravedNote {
  item: NoteItem | RestItem;
  x: number;
  position: number;
  glyph: MusicGlyphName;
  levels: number;
  /** Null for a whole note and for every rest. */
  stem: Stem | null;
}

function engraveBar(
  font: MusicFont,
  bar: LayoutBar,
  system: LayoutSystem,
  time: TimeSignature,
  options: EngraveOptions,
  bands: Bands,
  anchors: NoteAnchors,
  skipped: Map<LayoutBarItemKind, number>,
): SvgElement[] {
  const staveY = system.staveY;
  const before: SvgElement[] = [];
  const after: SvgElement[] = [];

  // The prefix is drawn inside the room layout allocated for it, left to right.
  let prefixX = bar.x + units(0.6);

  const chords: { anchorItemId: Id | null; text: string; plain: boolean }[] = [];
  const tuplets: { actual: number; memberIds: Id[] }[] = [];
  const endings: EndingItem[] = [];
  let hasRehearsalMark = false;

  for (const item of bar.items) {
    switch (item.kind) {
      case 'clef':
        before.push(clef(font, prefixX, staveY));
        prefixX += font.width('gClef') + units(0.4);
        break;

      case 'keySignature': {
        const drawn = keySignature(font, item.fifths, prefixX, staveY);
        before.push(...drawn.elements);
        prefixX += drawn.width + units(0.4);
        break;
      }

      case 'timeSignature': {
        const drawn = timeSignature(font, item.time, prefixX, staveY);
        before.push(...drawn.elements);
        prefixX += drawn.width;
        break;
      }

      case 'barNumber':
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

      case 'rehearsalMark':
        hasRehearsalMark = true;
        before.push(
          // The top of the band, not a baseline: the box's own padding is the adapter's
          // to allow for, and layout reserved the band from `bands.top` down.
          ...rehearsalMark(item.text, bar.x, bands.top, options.rehearsalFontSize),
        );
        break;

      case 'barline':
        // After the clef and key signature, not before them: a repeat sign belongs to
        // the music, and the prefix belongs to the system.
        before.push(...startBarline(font, item.barline, bar.x + bar.prefixWidth, staveY));
        break;

      case 'endBarline':
        after.push(...endBarline(font, item.barline, bar.x + bar.width, staveY));
        break;

      case 'ending':
        endings.push(item);
        break;

      case 'chordSymbol':
        chords.push({ anchorItemId: item.anchorItemId, text: item.text, plain: false });
        break;

      case 'annotation':
        chords.push({ anchorItemId: item.anchorItemId, text: item.text, plain: true });
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

  const placed = placeItems(font, bar);
  const groups = beamGroups(placed, time);
  const beamed = new Set<PlacedItem>(groups.flat());

  const notes = new Map<PlacedItem, EngravedNote>();
  for (const entry of placed) notes.set(entry, engraveItem(font, entry, staveY, null));

  // A beamed group takes one stem direction, so its members' stems are rebuilt from the
  // group's decision before the beam is fitted to them.
  const beams: SvgElement[] = [];
  const beamedIds = new Set<Id>();
  for (const group of groups) {
    const members: BeamMember[] = [];
    const direction = groupStemDirection(group.map((entry) => notes.get(entry)?.position ?? 0));
    for (const entry of group) {
      const rebuilt = engraveItem(font, entry, staveY, direction);
      notes.set(entry, rebuilt);
      if (entry.item.kind === 'note') beamedIds.add(entry.item.noteId);
      if (rebuilt.stem !== null) {
        members.push({ stem: rebuilt.stem, position: rebuilt.position, levels: rebuilt.levels });
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
      });
    }
    ink.push(...noteInk(font, note, staveY, beamed.has(entry)));
  }

  for (const spec of tuplets) {
    const members = spec.memberIds
      .map((id) => byItemId.get(id))
      .filter((note): note is EngravedNote => note !== undefined);
    const bracket = tupletBracket(font, members, spec.actual, beamedIds, staveY);
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
        y: bands.top + (hasRehearsalMark ? options.rehearsalFontSize * 2.2 : units(0.4)),
        fontSize: options.endingFontSize,
      }),
    );
  }

  for (const chord of chords) {
    const anchor = chord.anchorItemId === null ? undefined : byItemId.get(chord.anchorItemId);
    before.push(
      chordSymbol({
        text: chord.text,
        x: anchor?.x ?? bar.x + bar.prefixWidth + units(1),
        y: bands.chordBaseline,
        size: options.chordFontSize,
        plain: chord.plain,
      }),
    );
  }

  void skipped;
  return [...before, ...ink, ...beams, ...after];
}

function engraveItem(
  font: MusicFont,
  entry: PlacedItem,
  staveY: number,
  direction: StemDirection | null,
): EngravedNote {
  const { item } = entry;

  if (item.kind === 'rest') {
    return {
      item,
      x: entry.x,
      position: restPosition(item.duration),
      glyph: restFor(item.duration),
      levels: 0,
      stem: null,
    };
  }

  const glyph = noteheadFor(item.duration);
  const position = staffPosition(item.pitch);
  return {
    item,
    x: entry.x,
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
      elements.push(font.element(glyph, note.x - ACCIDENTAL_GAP - font.width(glyph), y));
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
): SvgElement[] | null {
  const first = members[0];
  const last = members[members.length - 1];
  if (first === undefined || last === undefined) return null;

  const direction = groupStemDirection(members.map((member) => member.position));
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

/**
 * What counts as one beamed group: a run of consecutive beamable notes inside one beat,
 * or one dotted beat in a compound meter. The same policy `@sibei/draw` hands VexFlow
 * (`vexBeamGroups`), because beam grouping is the adapter's by ADR-0014 and the two
 * adapters have to be comparable.
 *
 * A rest breaks a group, and so does a note too long to be beamed. Beams across rests are
 * a later slice.
 */
function groupTicks(time: TimeSignature): number {
  const compound = time.beatValue === 8 && time.beats % 3 === 0;
  return compound ? (TICKS_PER_WHOLE / 8) * 3 : beatTicks(time);
}

function beamGroups(placed: readonly PlacedItem[], time: TimeSignature): PlacedItem[][] {
  const ticks = groupTicks(time);
  const groups: PlacedItem[][] = [];
  let current: PlacedItem[] = [];
  let currentBeat = -1;

  const flush = (): void => {
    if (current.length > 1) groups.push(current);
    current = [];
  };

  for (const entry of placed) {
    const beamable = entry.item.kind === 'note' && beamCount(entry.item.duration) > 0;
    if (!beamable) {
      flush();
      currentBeat = -1;
      continue;
    }
    const beat = Math.floor(entry.item.onset / ticks);
    if (beat !== currentBeat) {
      flush();
      currentBeat = beat;
    }
    current.push(entry);
  }
  flush();

  return groups;
}

/** Makes an unhandled item kind a compile error, not a silently dropped glyph. */
function exhausted(item: never): never {
  throw new Error(`unhandled layout item kind: ${JSON.stringify(item)}`);
}
