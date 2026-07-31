import type { LayoutBar, NoteItem, RestItem } from '@sibei/layout';
import { units } from './bravura.js';

/**
 * Where each onset sits inside its bar box.
 *
 * Spacing inside the box is the adapter's, by the division of labour the layout
 * contract states (`layout/src/items.ts`, ADR-0014): layout hands over `bar.x`,
 * `bar.width` and `bar.prefixWidth`, and the adapter decides where in what is left each
 * onset goes. VexFlow does it with a `Formatter`; this does it with a proportion.
 *
 * **What is here is deliberately the crudest thing that lets the rest be judged.**
 * Onsets are placed in proportion to time and nothing else — no regard for how much room
 * a glyph actually needs, no allowance for an accidental, no minimum distance between two
 * noteheads. Real spacing is a slice of its own and V1b explicitly excludes it. Bar 6's
 * four sixteenths are where the absence shows: they crowd into the first quarter of the
 * bar and the natural lands on top of the note before it. That is the bar the gate looks
 * at, so it shows on purpose, and it is the first thing the replacement fixes.
 *
 * `bar.prefixWidth` exists because of this spike. Layout had always computed how wide a
 * bar's clef, key and time signature are and kept the number private, so an adapter that
 * wanted to know where the music starts guessed it a second time — and the two adapters
 * guessed differently, which the side-by-side made obvious.
 */

/** Room after the prefix before the first notehead, and before the next barline. */
const LEFT_PAD = units(1.2);
const RIGHT_PAD = units(1);

export interface PlacedItem {
  item: NoteItem | RestItem;
  /** Left edge of the notehead. */
  x: number;
}

/**
 * The ticks a bar's box represents. An overfull bar is drawn as written (ADR-0013), so
 * the span follows the contents when they exceed the meter rather than running past the
 * barline. A pickup's box is sized to its contents, so its own span is what it holds.
 */
function barSpan(bar: LayoutBar): number {
  if (bar.isPickup) return Math.max(bar.metrics.actual, 1);
  return Math.max(bar.metrics.expected, bar.metrics.actual, 1);
}

export function placeItems(bar: LayoutBar): PlacedItem[] {
  const left = bar.x + bar.prefixWidth + LEFT_PAD;
  const right = bar.x + bar.width - RIGHT_PAD;
  const span = Math.max(right - left, units(1));
  const ticks = barSpan(bar);

  const placed: PlacedItem[] = [];
  for (const item of bar.items) {
    if (item.kind !== 'note' && item.kind !== 'rest') continue;
    placed.push({ item, x: left + (item.onset / ticks) * span });
  }
  return placed;
}
