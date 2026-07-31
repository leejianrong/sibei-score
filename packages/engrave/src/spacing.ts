import type { LayoutBar, NoteItem, RestItem } from '@sibei/layout';
import { startBarlineWidth } from './barlines.js';
import type { Duration } from '@sibei/model';
import { TICKS_PER_QUARTER, durationTicks } from '@sibei/model';
import type { MusicFont, MusicGlyphName } from './font.js';
import { units } from './font.js';
import { dotsWidth, noteheadFor } from './stems.js';

/**
 * Where each onset sits inside its bar box.
 *
 * Spacing inside the box is the adapter's, by the division of labour the layout contract
 * states (`layout/src/items.ts`, ADR-0014): layout hands over `bar.x`, `bar.width` and
 * `bar.prefixWidth`, and the adapter decides where in what is left each onset goes.
 *
 * Two forces, and the whole model is how they are reconciled.
 *
 * **Time wants space, but not in proportion.** A sixteenth is a quarter of a quarter's
 * duration and gets nowhere near a quarter of its room: strict proportion crushes fast
 * passages into a smear and leaves whole notes stranded in white. The classical answer
 * is Gourlay's — space grows with the *root* of duration, `(ticks/quarter) ** 0.6` here,
 * which is what the spike's purely proportional placement was missing. On bar 6 it moves
 * the four sixteenths from a quarter of the bar to something near two fifths, which is
 * about where VexFlow's formatter puts them and about where they belong.
 *
 * **Glyphs want space absolutely.** An accidental is as wide as it is whatever the tempo,
 * and two noteheads must not touch however little time separates them. So each note also
 * carries a **rigid** width — its accidental, its notehead, its dots, and a minimum gap —
 * that spacing may never compress. This is the part the spike had none of, and it is why
 * bar 6's natural landed on top of the note before it.
 *
 * Reconciling them: rigid widths are taken out first, and only the slack that remains is
 * shared out in proportion to what time asks for. If a bar has no slack — too many notes
 * for the box layout gave it — every note falls back to its rigid width and the bar runs
 * long rather than illegible. An overfull bar is drawn as written (ADR-0013); it is not
 * this function's business to refuse one.
 */

/**
 * Gourlay's exponent. 1 would be strict proportion, 0 would give every note the same
 * room whatever its duration. Engravers land between 0.5 and 0.6; the higher end suits a
 * lead sheet, where a bar is mostly quarters and halves and the occasional run of
 * sixteenths should still read as fast.
 */
const DURATION_EXPONENT = 0.6;

/** What one quarter note asks for, before any of it is taken back for glyphs. */
const QUARTER_SPACE = units(3.2);

/** The least ink-free space between one note's glyphs and the next note's. */
const MIN_GAP = units(0.7);

/** Room between an accidental and the notehead it belongs to (Gould). */
export const ACCIDENTAL_GAP = units(0.2);

/**
 * Room after the prefix before the first glyph, and before the closing barline. Gould
 * puts a bar's first notehead about one and a half spaces clear of the barline; less than
 * that and the bar reads as crowded against the line even when its notes are well spaced.
 */
const LEFT_PAD = units(1.5);
const RIGHT_PAD = units(1);

/**
 * A rest's rigid width, until rests are drawn and can be measured like everything else.
 * A notehead's worth of room is close enough that nothing collides, and the gap it
 * leaves in a proof image is honest about what is missing.
 */
const REST_PLACEHOLDER = units(1.2);

export interface PlacedItem {
  item: NoteItem | RestItem;
  /** Left edge of the notehead. */
  x: number;
  /** Left edge of the accidental, when there is one; otherwise the same as `x`. */
  leftEdge: number;
}

/**
 * How much of its box a bar's music should actually fill.
 *
 * A bar that does not sum to the meter is stored, flagged and drawn as written
 * (ADR-0013), and "as written" is the operative word: two quarters justified across a
 * four-four bar read as two halves, which is not what the score says. Handing a short
 * bar only its share of the slack leaves the shortfall visible as white space at the
 * end, where a reader can see it. A pickup is short on purpose and its box is already
 * sized to its contents, so it fills.
 */
function fillRatio(bar: LayoutBar): number {
  if (bar.isPickup || bar.metrics.expected <= 0) return 1;
  return Math.min(1, bar.metrics.actual / bar.metrics.expected);
}

/** What a duration asks for on grounds of time alone. */
export function durationSpace(duration: Duration): number {
  const ticks = durationTicks(duration);
  return QUARTER_SPACE * (ticks / TICKS_PER_QUARTER) ** DURATION_EXPONENT;
}

interface Cell {
  item: NoteItem | RestItem;
  /** Room the accidental takes to the left of the notehead. */
  leadIn: number;
  /** Accidental, notehead and dots — the part spacing may not compress. */
  rigid: number;
  /** What this onset would like on grounds of duration. */
  wanted: number;
}

function cellFor(font: MusicFont, item: NoteItem | RestItem): Cell {
  const wanted = durationSpace(item.duration) + MIN_GAP;

  if (item.kind === 'rest') {
    return { item, leadIn: 0, rigid: REST_PLACEHOLDER + MIN_GAP, wanted };
  }

  const notehead = noteheadFor(item.duration);
  const leadIn =
    item.accidentalGlyph === null
      ? 0
      : font.width(accidentalGlyph(item.accidentalGlyph)) + ACCIDENTAL_GAP;

  return {
    item,
    leadIn,
    rigid: leadIn + font.width(notehead) + dotsWidth(font, item.duration) + MIN_GAP,
    wanted,
  };
}

/**
 * Where a bar's music can start: after its prefix, and after a repeat sign if it opens
 * with one. Layout's `prefixWidth` covers the clef, key and time signature; the repeat is
 * the adapter's to make room for.
 */
export function musicLeft(font: MusicFont, bar: LayoutBar): number {
  let x = bar.x + bar.prefixWidth;
  for (const item of bar.items) {
    if (item.kind === 'barline') x += startBarlineWidth(font, item.barline);
  }
  return x + LEFT_PAD;
}

export function placeItems(font: MusicFont, bar: LayoutBar): PlacedItem[] {
  const cells: Cell[] = [];
  for (const item of bar.items) {
    if (item.kind === 'note' || item.kind === 'rest') cells.push(cellFor(font, item));
  }
  if (cells.length === 0) return [];

  const left = musicLeft(font, bar);
  const available = Math.max(bar.x + bar.width - RIGHT_PAD - left, 0);

  // Rigid first, then share what is left in proportion to what time asked for. A bar
  // with no slack keeps every glyph legible and runs long, which is the lesser evil.
  const rigidTotal = cells.reduce((sum, cell) => sum + cell.rigid, 0);
  const wantedTotal = cells.reduce((sum, cell) => sum + cell.wanted, 0);
  const slack = Math.max(available - rigidTotal, 0) * fillRatio(bar);

  const widths = cells.map((cell) =>
    wantedTotal === 0 ? cell.rigid : cell.rigid + slack * (cell.wanted / wantedTotal),
  );

  const placed: PlacedItem[] = [];
  let x = left;
  for (const [index, cell] of cells.entries()) {
    placed.push({ item: cell.item, x: x + cell.leadIn, leftEdge: x });
    x += widths[index] ?? cell.rigid;
  }
  return placed;
}

/**
 * Which accidental glyph an alteration draws. Lives here rather than with the note
 * engraver because spacing has to know an accidental's width before anything is drawn —
 * which is the whole reason accidentals used to collide.
 */
export function accidentalGlyph(alter: -2 | -1 | 0 | 1 | 2): MusicGlyphName {
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

/** Kept so the placement model can be asserted rather than only looked at. */
export const SPACING = {
  durationExponent: DURATION_EXPONENT,
  quarterSpace: QUARTER_SPACE,
  minGap: MIN_GAP,
  restPlaceholder: REST_PLACEHOLDER,
  leftPad: LEFT_PAD,
  rightPad: RIGHT_PAD,
} as const;
