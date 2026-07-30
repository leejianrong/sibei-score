import type {
  LayoutBar,
  LayoutBarItemKind,
  LayoutResult,
  LayoutSystem,
  NoteItem,
} from '@sibei/layout';
import type { KeySignature, TimeSignature } from '@sibei/model';
import { TICKS_PER_WHOLE, beatTicks } from '@sibei/model';
import type { BravuraGlyphName } from './bravura.js';
import { glyphElement, glyphWidth } from './bravura.js';
import type { BeamMember } from './beams.js';
import { applyBeam, beamElements, beamLine } from './beams.js';
import type { PlacedItem } from './spacing.js';
import { placeItems } from './spacing.js';
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

/**
 * The engraver spike (ADR-0030): a second draw adapter, behind the same seam, that
 * engraves from Bravura's published metrics instead of through VexFlow.
 *
 * It consumes the layout contract and nothing else, exactly as `@sibei/draw` does. It
 * differs from that adapter in one way worth noting beyond the obvious: it emits
 * **markup rather than DOM nodes**, so it needs no `document` and this package stays as
 * framework-free as `layout` and `model`.
 *
 * **Scope is one note and everything attached to it** — noteheads, stems, flags, ledger
 * lines, beams, accidentals, augmentation dots — plus the staff lines to read them
 * against. Everything else the contract can emit is counted and skipped, and the count
 * is returned rather than swallowed, so a proof image cannot quietly imply coverage the
 * spike does not have. Rests, ties, tuplet brackets, clefs, key and time signatures,
 * barlines and chord symbols are all a later slice (ADR-0030).
 */

export interface EngraveOptions {
  /** Off for the side-by-side, where VexFlow's staff is already underneath. */
  staffLines: boolean;
}

const DEFAULT_OPTIONS: EngraveOptions = { staffLines: true };

export interface EngravedPage {
  /** Standalone SVG markup, in the same coordinates and at the same size as `@sibei/draw`. */
  svg: string;
  /** Item kinds the spike does not draw, and how many it passed over. */
  skipped: readonly { kind: LayoutBarItemKind; count: number }[];
}

/** Every kind this adapter draws. The rest are counted as skipped, by name. */
export const ENGRAVED_ITEM_KINDS: readonly LayoutBarItemKind[] = ['note'];

export function engravePage(
  result: LayoutResult,
  pageIndex: number,
  options: Partial<EngraveOptions> = {},
): EngravedPage {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const page = result.pages[pageIndex];
  if (page === undefined) throw new Error(`no such page: ${pageIndex}`);

  const skipped = new Map<LayoutBarItemKind, number>();
  const children: SvgElement[] = [];
  for (const system of page.systems) {
    children.push(...engraveSystem(system, result.key, result.time, opts, skipped));
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

export function engraveSystem(
  system: LayoutSystem,
  key: KeySignature,
  time: TimeSignature,
  options: EngraveOptions,
  skipped: Map<LayoutBarItemKind, number>,
): SvgElement[] {
  const children: SvgElement[] = [];
  if (options.staffLines) {
    children.push(
      ...staffLines({ x: system.x, width: system.width, staveY: system.staveY }),
    );
  }
  for (const bar of system.bars) {
    children.push(...engraveBar(bar, system.staveY, key, time, skipped));
  }
  return children;
}

// ---------------------------------------------------------------------------
// A bar
// ---------------------------------------------------------------------------

/** One note, with its geometry settled but nothing emitted yet. */
interface EngravedNote {
  item: NoteItem;
  x: number;
  position: number;
  notehead: BravuraGlyphName;
  levels: number;
  /** Null for a whole note. */
  stem: Stem | null;
}

/**
 * Geometry first, ink second — and the order is the lesson of V1's beaming bug, where
 * notes drew their own flags because the beams that would have suppressed them were
 * built afterwards. Here nothing is emitted until every beam has been fitted and every
 * stem end rewritten, so a beamed note cannot be asked twice what it is.
 */
function engraveBar(
  bar: LayoutBar,
  staveY: number,
  key: KeySignature,
  time: TimeSignature,
  skipped: Map<LayoutBarItemKind, number>,
): SvgElement[] {
  for (const item of bar.items) {
    if (!ENGRAVED_ITEM_KINDS.includes(item.kind)) {
      skipped.set(item.kind, (skipped.get(item.kind) ?? 0) + 1);
    }
  }

  const placed = placeItems(bar, key);
  const groups = beamGroups(placed, time);
  const beamed = new Set<PlacedItem>(groups.flat());

  const notes = new Map<PlacedItem, EngravedNote>();
  for (const entry of placed) {
    if (entry.item.kind !== 'note') continue;
    notes.set(entry, engraveNote(entry.item, entry.x, staveY, null));
  }

  // A beamed group takes one stem direction, so its members' stems are rebuilt from the
  // group's decision before the beam is fitted to them.
  const beams: SvgElement[] = [];
  for (const group of groups) {
    const members: BeamMember[] = [];
    const positions = group.map((entry) => notes.get(entry)?.position ?? 0);
    const direction = groupStemDirection(positions);
    for (const entry of group) {
      if (entry.item.kind !== 'note') continue;
      const rebuilt = engraveNote(entry.item, entry.x, staveY, direction);
      notes.set(entry, rebuilt);
      if (rebuilt.stem !== null) {
        members.push({ stem: rebuilt.stem, position: rebuilt.position, levels: rebuilt.levels });
      }
    }
    if (members.length < 2) continue;
    const line = beamLine(members);
    applyBeam(line, members);
    beams.push(...beamElements(line, members));
  }

  const ink: SvgElement[] = [];
  for (const entry of placed) {
    const note = notes.get(entry);
    if (note !== undefined) ink.push(...noteInk(note, staveY, beamed.has(entry)));
  }
  return [...ink, ...beams];
}

/** `direction` is the beamed group's when there is one, and null when the note decides. */
function engraveNote(
  item: NoteItem,
  x: number,
  staveY: number,
  direction: StemDirection | null,
): EngravedNote {
  const notehead = noteheadFor(item.duration);
  const position = staffPosition(item.pitch);
  return {
    item,
    x,
    position,
    notehead,
    levels: beamCount(item.duration),
    stem: hasStem(item.duration)
      ? stem({
          notehead,
          direction: direction ?? stemDirection(position),
          noteX: x,
          position,
          staveY,
        })
      : null,
  };
}

function noteInk(note: EngravedNote, staveY: number, isBeamed: boolean): SvgElement[] {
  const elements: SvgElement[] = [];
  const noteY = positionY(note.position, staveY);

  elements.push(
    ...ledgerLines({
      noteX: note.x,
      noteheadWidth: glyphWidth(note.notehead),
      position: note.position,
      staveY,
    }),
  );

  if (note.item.accidentalGlyph !== null) {
    const glyph = accidentalGlyph(note.item.accidentalGlyph);
    elements.push(glyphElement(glyph, note.x - ACCIDENTAL_GAP - glyphWidth(glyph), noteY));
  }

  elements.push(glyphElement(note.notehead, note.x, noteY));

  for (const dot of dotPositions(
    note.item.duration,
    note.notehead,
    note.x,
    note.position,
    staveY,
  )) {
    elements.push(glyphElement('augmentationDot', dot.x, dot.y));
  }

  if (note.stem !== null) {
    elements.push(stemElement(note.stem));
    if (!isBeamed) {
      const flag = flagFor(note.item.duration, note.stem.direction);
      if (flag !== null) {
        const origin = flagOrigin(flag, note.stem);
        elements.push(glyphElement(flag, origin.x, origin.y));
      }
    }
  }

  return elements;
}

/** Gould: an accidental sits a fifth of a space clear of the notehead it belongs to. */
const ACCIDENTAL_GAP = 2;

function accidentalGlyph(alter: -2 | -1 | 0 | 1 | 2): BravuraGlyphName {
  switch (alter) {
    case -2:
      return 'accidentalDoubleFlat';
    case -1:
      return 'accidentalFlat';
    case 0:
      return 'accidentalNatural';
    case 1:
      return 'accidentalSharp';
    case 2:
      return 'accidentalDoubleSharp';
  }
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
 * A rest breaks a group, and so does a note too long to be beamed. Beams across rests
 * are a later slice.
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
