import type { Bar, Score } from '@sibei/model';
import { keySignatureAccidentals } from '@sibei/model';
import type { PageSpec } from './page.js';
import type { PlannedSystem } from './grid.js';

/**
 * Justification: how a system's width is divided between its bars. Ours, because
 * VexFlow supplies no policy of this kind (ADR-0014, ADR-0015).
 */

export interface BarPrefix {
  clef: boolean;
  keySignature: boolean;
  timeSignature: boolean;
}

export interface AllocatedBar {
  bar: Bar;
  x: number;
  width: number;
  isPickup: boolean;
  prefix: BarPrefix;
  /** Room this bar's clef, key signature and time signature were allocated. */
  prefixWidth: number;
}

/** Rough widths in units, only ever used as allocation weights. */
const PADDING = 24;
const CLEF_WIDTH = 34;
const KEY_ACCIDENTAL_WIDTH = 13;
const TIME_SIGNATURE_WIDTH = 28;
const NOTE_WIDTH = 26;
const REST_WIDTH = 24;
const ACCIDENTAL_WIDTH = 14;
const DOT_WIDTH = 6;
const CHORD_CHARACTER_WIDTH = 7;
const CHORD_GAP = 14;

/**
 * How much of a bar's box its clef, key signature and time signature take up.
 *
 * Published on every `AllocatedBar` and carried into the layout contract, because an
 * adapter needs it to know where a bar's *music* starts and cannot work it out: it is
 * layout's own allocation, not a measurement of any font's glyphs. Keeping it private
 * meant each adapter guessed a second time and the two disagreed on the x of a bar's
 * first notehead — which the V1b spike's side-by-side made obvious
 * (`docs/v1b-engraver-spike.md`).
 */
function prefixWidth(score: Score, prefix: BarPrefix): number {
  let width = 0;
  if (prefix.clef) width += CLEF_WIDTH;
  if (prefix.keySignature) {
    width += KEY_ACCIDENTAL_WIDTH * keySignatureAccidentals(score.meta.key).size;
  }
  if (prefix.timeSignature) width += TIME_SIGNATURE_WIDTH;
  return width;
}

/**
 * How much room a bar would like. A weight, not a measurement — the draw adapter's
 * formatter does the real spacing inside whatever box it is given.
 */
export function estimateBarWidth(score: Score, bar: Bar, prefix: BarPrefix): number {
  const keyAccidentals = keySignatureAccidentals(score.meta.key);

  let notes = PADDING;
  for (const item of bar.items) {
    if (item.kind === 'rest') {
      notes += REST_WIDTH;
      continue;
    }
    const keyAlter = keyAccidentals.get(item.pitch.step) ?? 0;
    const drawsAccidental = item.accidental === 'show' || item.pitch.alter !== keyAlter;
    notes += NOTE_WIDTH + (drawsAccidental ? ACCIDENTAL_WIDTH : 0) + item.duration.dots * DOT_WIDTH;
  }

  let chords = 0;
  for (const chord of [...bar.chords, ...bar.annotations]) {
    chords += chord.text.length * CHORD_CHARACTER_WIDTH + CHORD_GAP;
  }

  return prefixWidth(score, prefix) + Math.max(notes, chords);
}

/**
 * A pickup is sized to its contents, not to a share of the system. Two things follow
 * from that, and both are what a chart looks like: the pickup stays visibly a lead-in
 * rather than a bar, and its notes sit snug instead of being justified across a box
 * far wider than they need — the adapter's formatter fills whatever width it is given.
 *
 * The clef, key signature and time signature all sit inside the pickup, so the prefix
 * is part of its width. Sizing on the notes alone leaves nowhere to put them and they
 * spill past the barline.
 *
 * The four grid bars that follow are still four bars: the pickup takes its width off
 * the top and consumes no slot (ADR-0015).
 */
const MIN_PICKUP_NOTE_WIDTH = 46;

function pickupWidth(score: Score, bar: Bar, prefix: BarPrefix, available: number): number {
  const prefixOnly = prefixWidth(score, prefix);
  const contents = estimateBarWidth(score, bar, prefix) - prefixOnly;
  const notes = Math.max(contents, MIN_PICKUP_NOTE_WIDTH);
  return Math.min(prefixOnly + notes, available * 0.35);
}

export interface AllocateOptions {
  /** The very first bar of the score carries the time signature. */
  isFirstSystem: boolean;
}

export function allocateWidths(
  score: Score,
  system: PlannedSystem,
  spec: PageSpec,
  options: AllocateOptions,
): AllocatedBar[] {
  const left = spec.margin.left;
  const available = spec.width - spec.margin.left - spec.margin.right;

  const allocated: AllocatedBar[] = [];
  let x = left;
  let remaining = available;

  if (system.pickup !== null) {
    // The pickup is the first bar of the score, so it carries the whole prefix.
    const prefix: BarPrefix = { clef: true, keySignature: true, timeSignature: true };
    const width = pickupWidth(score, system.pickup, prefix, available);
    allocated.push({
      bar: system.pickup,
      x,
      width,
      isPickup: true,
      prefix,
      prefixWidth: prefixWidth(score, prefix),
    });
    x += width;
    remaining -= width;
  }

  const prefixes: BarPrefix[] = system.bars.map((_, index) => ({
    // Clef and key signature repeat at the head of every system.
    clef: index === 0 && system.pickup === null,
    keySignature: index === 0 && system.pickup === null,
    // One time signature per chart (ADR-0021), so it appears once, at the very start.
    timeSignature: index === 0 && options.isFirstSystem && system.pickup === null,
  }));

  const weights = system.bars.map((bar, index) =>
    estimateBarWidth(score, bar, prefixes[index] ?? noPrefix()),
  );
  const widths = distribute(weights, remaining, spec);

  for (const [index, bar] of system.bars.entries()) {
    const isLast = index === system.bars.length - 1;
    // The last bar absorbs rounding so a system's right edge lands exactly on the margin.
    const width = isLast ? left + available - x : (widths[index] ?? 0);
    const prefix = prefixes[index] ?? noPrefix();
    allocated.push({
      bar,
      x,
      width,
      isPickup: false,
      prefix,
      prefixWidth: prefixWidth(score, prefix),
    });
    x += width;
  }

  return allocated;
}

function noPrefix(): BarPrefix {
  return { clef: false, keySignature: false, timeSignature: false };
}

/**
 * Blend an equal share with a content-proportional one, then hold a floor. Charts
 * read as a grid, so `equalWeight` leans high (ADR-0015).
 */
function distribute(weights: readonly number[], total: number, spec: PageSpec): number[] {
  const count = weights.length;
  if (count === 0) return [];
  const weightTotal = weights.reduce((sum, w) => sum + w, 0);
  const equal = spec.equalWeight;

  const raw = weights.map((weight) => {
    const proportional = weightTotal === 0 ? 1 / count : weight / weightTotal;
    return total * (equal / count + (1 - equal) * proportional);
  });

  const floored = raw.map((width) => Math.max(width, spec.minBarWidth));
  const flooredTotal = floored.reduce((sum, w) => sum + w, 0);
  const scale = flooredTotal === 0 ? 1 : total / flooredTotal;
  return floored.map((width) => width * scale);
}
