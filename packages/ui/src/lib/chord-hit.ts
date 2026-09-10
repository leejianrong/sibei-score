import { DEFAULT_CHORD_FONT_SIZE, placeItems, units } from '@sibei/engrave';
import type { MusicFont } from '@sibei/engrave';
import type { LayoutBar, LayoutPage, LayoutSystem } from '@sibei/layout';
import type { Id, TimeSignature } from '@sibei/model';
import type { Point } from './hit-test.js';

/**
 * Mapping a click to a chord symbol, or to the empty beat where a new one goes — V5e.
 *
 * Like `hit-test.ts`, this is **not a second opinion about geometry**. A chord's baseline is
 * `system.staveY - system.chordBaselineOffset`, exactly what `engraveSystem` draws it at, and its
 * x is the anchor note's x from `placeItems` — the same function the engraver and the note
 * hit-test both call — or the same `bar.x + prefixWidth + units(1)` fallback the engraver uses when
 * a beat has no note under it. So a target here can never sit where the ink is not. Nothing is
 * measured (ADR-0015): a chord's width is estimated from its character count, the way the engraver
 * sizes a rehearsal box, never from `getBBox`.
 */

export interface ChordBox {
  /** The chord's own id, so an edit can address it precisely. */
  chordId: Id;
  /** The beat address both surfaces speak — `bar3.beat1` (ADR-0007, Q32). */
  addr: string;
  barNumber: number;
  beat: number;
  text: string;
  /** A free annotation (Q56), not a chord — it is never offered the grammar. */
  plain: boolean;
  /** Layout units, the page's own `viewBox` space. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a click in the chord band lands, when there is no chord there yet: an empty beat. */
export interface BeatSlot {
  addr: string;
  barNumber: number;
  beat: number;
  /** Layout units — a marker's box, for the hover affordance. */
  x: number;
  y: number;
  width: number;
  height: number;
}

const SIZE = DEFAULT_CHORD_FONT_SIZE;
/** A chord rises about this far above its baseline (root height plus a superscript). */
const RISE = SIZE * 1.15;
/** Rough advance per character in the serif chord face — the estimate `rehearsalMark` also makes. */
const CHAR = SIZE * 0.6;

/** How far past a chord's box a click still counts, matching the note hit-test's generosity. */
const HIT_MARGIN = units(1.2);

/** The chord a point lands on — nearest within the margin wins, exactly as `hitTest` does. */
export function chordAt(boxes: readonly ChordBox[], point: Point): ChordBox | null {
  let best: ChordBox | null = null;
  let bestDistance = Infinity;
  for (const box of boxes) {
    const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width));
    const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height));
    const distance = Math.hypot(dx, dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = box;
    }
  }
  return best !== null && bestDistance <= HIT_MARGIN ? best : null;
}

/** Every chord symbol on a page, boxed where the engraver placed and sized it. */
export function pageChordBoxes(page: LayoutPage, font: MusicFont): ChordBox[] {
  const boxes: ChordBox[] = [];
  for (const system of page.systems) {
    const baseline = system.staveY - system.chordBaselineOffset;
    for (const bar of system.bars) {
      const noteX = noteXByItemId(font, bar);
      for (const item of bar.items) {
        if (item.kind !== 'chordSymbol' && item.kind !== 'annotation') continue;
        const x = item.anchorItemId === null ? fallbackX(bar) : (noteX.get(item.anchorItemId) ?? fallbackX(bar));
        const width = Math.max(SIZE * 1.5, item.text.length * CHAR);
        boxes.push({
          chordId: item.kind === 'chordSymbol' ? item.chordId : item.annotationId,
          addr: `bar${bar.barNumber}.beat${trimBeat(item.beat)}`,
          barNumber: bar.barNumber,
          beat: item.beat,
          text: item.text,
          plain: item.kind === 'annotation',
          x,
          y: baseline - RISE,
          width,
          height: RISE + SIZE * 0.35,
        });
      }
    }
  }
  return boxes;
}

/**
 * The beat a point in the chord band resolves to, or `null` when the point is not in a band or not
 * over a bar. This is the "click above the staff to add a chord" target (the approved V5e
 * interaction): the x within a bar's music area snaps to the nearest whole beat, so a chord can be
 * placed on a beat that has no note under it — which is exactly what beat anchoring is for (Q32).
 */
export function beatSlotAt(page: LayoutPage, point: Point, time: TimeSignature): BeatSlot | null {
  for (const system of page.systems) {
    const baseline = system.staveY - system.chordBaselineOffset;
    const bandTop = baseline - RISE - units(0.5);
    const bandBottom = system.staveY - units(0.5);
    if (point.y < bandTop || point.y > bandBottom) continue;

    for (const bar of system.bars) {
      if (point.x < bar.x || point.x > bar.x + bar.width) continue;
      const beat = nearestBeat(bar, point.x, time);
      const width = SIZE * 2;
      return {
        addr: `bar${bar.barNumber}.beat${beat}`,
        barNumber: bar.barNumber,
        beat,
        x: beatX(bar, beat, time) - width / 2,
        y: baseline - RISE,
        width,
        height: RISE + SIZE * 0.35,
      };
    }
  }
  return null;
}

function noteXByItemId(font: MusicFont, bar: LayoutBar): Map<Id, number> {
  const map = new Map<Id, number>();
  for (const placed of placeItems(font, bar)) {
    const id = placed.item.kind === 'note' ? placed.item.noteId : placed.item.restId;
    map.set(id, placed.x);
  }
  return map;
}

function fallbackX(bar: LayoutBar): number {
  return bar.x + bar.prefixWidth + units(1);
}

/** The music area of a bar, past its clef/key/time prefix. */
function musicSpan(bar: LayoutBar): { left: number; right: number } {
  return { left: bar.x + bar.prefixWidth, right: bar.x + bar.width };
}

function nearestBeat(bar: LayoutBar, x: number, time: TimeSignature): number {
  const { left, right } = musicSpan(bar);
  const fraction = right <= left ? 0 : Math.min(1, Math.max(0, (x - left) / (right - left)));
  return Math.min(time.beats, Math.max(1, 1 + Math.round(fraction * (time.beats - 1))));
}

function beatX(bar: LayoutBar, beat: number, time: TimeSignature): number {
  const { left, right } = musicSpan(bar);
  const fraction = time.beats <= 1 ? 0 : (beat - 1) / (time.beats - 1);
  return left + fraction * (right - left);
}

/** `3`, not `3.0`, matching how the address resolver and projection print a beat. */
function trimBeat(beat: number): string {
  return Number(beat.toFixed(4)).toString();
}
