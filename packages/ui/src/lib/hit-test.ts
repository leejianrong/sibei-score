import {
  PERCUSSION_LINE,
  musicFontNamed,
  noteShifts,
  noteheadFor,
  percussionNoteheadFor,
  placeAligned,
  placeItems,
  positionY,
  restFor,
  restPosition,
  restShiftOf,
  staffPosition,
  staffPositionIn,
  units,
  voicesWithMusic,
} from '@sibei/engrave';
import type { MusicFont, MusicFontName } from '@sibei/engrave';
import type { LayoutBar, LayoutPage, NoteItem, RestItem } from '@sibei/layout';
import { writtenPitch } from '@sibei/layout';
import type { Id } from '@sibei/model';

/**
 * Mapping a click to a note or a rest — V4c (KAN-589).
 *
 * **Not a second opinion about geometry.** Every position here comes from the exact functions
 * the engraver itself calls to draw the ink — `placeItems`, `staffPosition`, `positionY`,
 * `noteheadFor`/`restFor` for the glyph, `font.box`/`font.width` for its footprint — so this
 * module can never disagree with what is on the page. In particular, a tie is drawn from
 * `LayoutTie` anchors that never pass through here, so a click near a tie's curve is judged only
 * against the noteheads it connects, never against ink this module does not know exists
 * (SLICES.md names a tied note as hit-testing's own test case).
 *
 * **Never measures anything.** No `getBBox`, no `measureText` — every box below is computed from
 * font metrics and layout positions, the same inputs the SVG was built from, before a single
 * pixel exists on screen (ADR-0015).
 */

export interface ItemBox {
  id: Id;
  kind: 'note' | 'rest';
  /** The staff it sits on, as its index in the system's `staves` (0 for a one-staff chart), and its voice (1-based). */
  staffIndex: number;
  voice: number;
  /** Layout units — the same space as the page's SVG `viewBox`. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export function loadFont(name: MusicFontName): MusicFont {
  return musicFontNamed(name);
}

/**
 * Every note and rest on a page, boxed exactly as the engraver placed and sized them. A one-staff,
 * one-voice chart takes the original path below; a staved system (ADR-0041) walks every staff and voice
 * the way `engraveStavedSystem` does — aligned x, the staff's clef, a voice's rest offset and the head
 * moved aside for another voice — so a click on staff 2, voice 2 hits the ink it was drawn as.
 */
export function pageItemBoxes(page: LayoutPage, font: MusicFont): ItemBox[] {
  const boxes: ItemBox[] = [];
  for (const system of page.systems) {
    if (system.staves !== undefined) {
      for (const staff of system.staves) {
        for (const [barIndex, staffBar] of staff.bars.entries()) {
          const bar = system.bars[barIndex];
          if (bar === undefined) continue;
          for (const voice of staffBar.voices) {
            const layoutBar: LayoutBar = { ...bar, items: voice.items };
            const shifts = noteShifts(font, { voice, voices: staffBar.voices, clef: staffBar.clef ?? staff.clef });
            const restShift = restShiftOf(voice, staffBar.voices);
            const percussion = staff.type === 'percussion';
            for (const placed of placeAligned(font, layoutBar, voicesWithMusic(staffBar.voices) < 2)) {
              const { item } = placed;
              const glyph =
                item.kind === 'note' ? (percussion ? percussionNoteheadFor(item.duration) : noteheadFor(item.duration)) : restFor(item.duration);
              const position =
                item.kind === 'note'
                  ? percussion
                    ? PERCUSSION_LINE
                    : staffPositionIn(writtenPitch(item.pitch, item.ottava), staffBar.clef ?? staff.clef)
                  : restPosition(item.duration) + restShift;
              const y = positionY(position, staff.staveY);
              const box = font.box(glyph);
              const dx = item.kind === 'note' ? (shifts.get(item.noteId)?.dx ?? 0) : 0;
              boxes.push({
                id: item.kind === 'note' ? item.noteId : item.restId,
                kind: item.kind,
                staffIndex: staff.index,
                voice: voice.index,
                x: placed.x + dx,
                y: y + box.top,
                width: font.width(glyph),
                height: box.height,
              });
            }
          }
        }
      }
      continue;
    }
    for (const bar of system.bars) {
      for (const placed of placeItems(font, bar)) {
        const { item } = placed;
        const glyph = item.kind === 'note' ? noteheadFor(item.duration) : restFor(item.duration);
        const position = item.kind === 'note' ? staffPosition(writtenPitch(item.pitch, item.ottava)) : restPosition(item.duration);
        const y = positionY(position, system.staveY);
        const box = font.box(glyph);
        boxes.push({
          id: item.kind === 'note' ? item.noteId : item.restId,
          kind: item.kind,
          staffIndex: 0,
          voice: 1,
          x: placed.x,
          y: y + box.top,
          width: font.width(glyph),
          height: box.height,
        });
      }
    }
  }
  return boxes;
}

/**
 * How far past a box's edge a click still counts as hitting it. A notehead is a few units
 * wide; a pointer is not a pixel, so the target it hits has to be more generous than the ink.
 */
const HIT_MARGIN = units(1.2);

function distanceToBox(box: ItemBox, point: Point): number {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
  return Math.hypot(dx, dy);
}

/** The nearest box to a point, or `null` when nothing on the page is close enough to count. */
export function hitTest(boxes: readonly ItemBox[], point: Point): ItemBox | null {
  let best: ItemBox | null = null;
  let bestDistance = Infinity;
  for (const box of boxes) {
    const distance = distanceToBox(box, point);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = box;
    }
  }
  return best !== null && bestDistance <= HIT_MARGIN ? best : null;
}

/** The box for an id already known — after a fresh render, to redraw the selection outline. */
export function boxFor(boxes: readonly ItemBox[], id: Id): ItemBox | null {
  return boxes.find((box) => box.id === id) ?? null;
}

export interface LocatedItem {
  item: NoteItem | RestItem;
  /** Which bar it sits in — a rest's address for `rest.add` needs it; a note's does not (V4c
   *  addresses an existing note by its own id, never by position). */
  barNumber: number;
  /** Its staff (index in the system's `staves`) and voice, so an edit by position can be qualified. */
  staffIndex: number;
  voice: number;
}

/**
 * The layout contract's own note or rest for an id, on this page — pitch, duration, accidental,
 * tie, all resolved exactly as the engraver reads them. The inspector's fields come from here,
 * never from re-deriving them out of the stored `Score` a second way.
 */
export function findItem(page: LayoutPage, id: Id): LocatedItem | null {
  const idOf = (item: NoteItem | RestItem): Id => (item.kind === 'note' ? item.noteId : item.restId);
  for (const system of page.systems) {
    if (system.staves !== undefined) {
      for (const staff of system.staves) {
        for (const [barIndex, staffBar] of staff.bars.entries()) {
          const barNumber = system.bars[barIndex]?.barNumber;
          if (barNumber === undefined) continue;
          for (const voice of staffBar.voices) {
            for (const item of voice.items) {
              if ((item.kind === 'note' || item.kind === 'rest') && idOf(item) === id) {
                return { item, barNumber, staffIndex: staff.index, voice: voice.index };
              }
            }
          }
        }
      }
      continue;
    }
    for (const bar of system.bars) {
      for (const item of bar.items) {
        if ((item.kind === 'note' || item.kind === 'rest') && idOf(item) === id) {
          return { item, barNumber: bar.barNumber, staffIndex: 0, voice: 1 };
        }
      }
    }
  }
  return null;
}
