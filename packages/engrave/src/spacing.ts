import type { LayoutBar, NoteItem, RestItem } from '@sibei/layout';
import type { KeySignature } from '@sibei/model';
import { keySignatureAccidentals } from '@sibei/model';
import { units } from './bravura.js';

/**
 * Where each onset sits inside its bar box.
 *
 * Spacing inside the box is the adapter's, by the division of labour the layout
 * contract states (`layout/src/items.ts`, ADR-0014): layout hands over `bar.x` and
 * `bar.width` and the adapter decides where in that box each onset goes. VexFlow does
 * it with a `Formatter`; this does it with a proportion.
 *
 * **What is here is deliberately the crudest thing that lets the rest be judged.**
 * Onsets are placed in proportion to time and nothing else — no regard for how much
 * room a glyph actually needs, no allowance for an accidental, no minimum distance
 * between two noteheads. Real spacing is a slice of its own and V1b explicitly excludes
 * it. Bar 6's four sixteenths are where the absence shows, and they are the bar the
 * gate is looking at, so it shows on purpose.
 *
 * One thing here is a seam gap rather than a scope choice, and it is a result of the
 * spike: the **prefix allowance** below. Layout already computed how wide the clef, key
 * and time signature are — `widths.ts` sizes every bar around them — but the contract
 * does not publish the number, so an adapter that wants to know where the music starts
 * has to guess it a second time. VexFlow guesses it too, from its own glyph tables,
 * which is why the two engravings do not agree on where a bar's first notehead sits.
 * See `docs/v1b-engraver-spike.md`.
 */

/**
 * Prefix allowances, in layout units: the same rough numbers `layout/src/widths.ts`
 * uses as weights, so this spike's noteheads land near VexFlow's and the comparison is
 * of engraving rather than of two different spacings. That they have to be written down
 * twice is the argument for publishing them once.
 */
const CLEF_ALLOWANCE = units(3.4);
const KEY_ACCIDENTAL_ALLOWANCE = units(1.3);
const TIME_SIGNATURE_ALLOWANCE = units(2.8);

/** Room after the barline before the first notehead, and before the next barline. */
const LEFT_PAD = units(1.2);
const RIGHT_PAD = units(1);

function prefixAllowance(bar: LayoutBar, key: KeySignature): number {
  let allowance = 0;
  if (bar.prefix.clef) allowance += CLEF_ALLOWANCE;
  if (bar.prefix.keySignature) {
    allowance += KEY_ACCIDENTAL_ALLOWANCE * keySignatureAccidentals(key).size;
  }
  if (bar.prefix.timeSignature) allowance += TIME_SIGNATURE_ALLOWANCE;
  return allowance;
}

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

export function placeItems(bar: LayoutBar, key: KeySignature): PlacedItem[] {
  const left = bar.x + prefixAllowance(bar, key) + LEFT_PAD;
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
