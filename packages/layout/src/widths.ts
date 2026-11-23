import type { Alter, BarView, Note, Score, Step } from '@sibei/model';
import { STEPS, keySignatureAccidentals } from '@sibei/model';
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
  bar: BarView;
  x: number;
  width: number;
  isPickup: boolean;
  prefix: BarPrefix;
  /** Whether this bar starts its system — the bar a system's bar number sits on. Not the same as having a clef. */
  headsSystem: boolean;
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
const GRACE_WIDTH = 16;
const CHORD_CHARACTER_WIDTH = 7;
const CHORD_GAP = 14;

/**
 * What a stacked chord adds to a column (SIB2-243): an accidental column for the pitches that draw one (at most three
 * side by side, which is where the engraver starts packing them back under each other) and one more notehead's width
 * when two heads are a second apart (the head that moves to the other side of the stem). Zero for a lone note.
 */
function chordExtra(
  item: Note,
  keyAccidentals: ReadonlyMap<Step, Alter>,
  head: number,
  accidental: number,
): number {
  if (item.stack === undefined || item.stack.length === 0) return 0;
  const tones = [item, ...item.stack];
  const drawing = tones.filter(
    (tone) => tone.accidental === 'show' || tone.accidental === 'parens' || (tone.accidental !== 'hide' && tone.pitch.alter !== (keyAccidentals.get(tone.pitch.step) ?? 0)),
  ).length;
  // The primary's own accidental is counted by the caller; the others add columns up to three in all.
  const primary = tones[0] === item && (item.accidental === 'show' || item.accidental === 'parens' || item.pitch.alter !== (keyAccidentals.get(item.pitch.step) ?? 0)) ? 1 : 0;
  const columns = Math.min(drawing, 3) - Math.min(primary, 1);
  const degrees = tones.map((tone) => tone.pitch.octave * 7 + STEPS.indexOf(tone.pitch.step)).sort((a, b) => a - b);
  const hasSecond = degrees.some((degree, at) => at > 0 && degree - (degrees[at - 1] as number) === 1);
  return Math.max(columns, 0) * accidental + (hasSecond ? head : 0);
}

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
export function estimateBarWidth(score: Score, bar: BarView, prefix: BarPrefix): number {
  const keyAccidentals = keySignatureAccidentals(score.meta.key);

  let notes = PADDING;
  for (const item of bar.items) {
    if (item.kind === 'rest') {
      notes += REST_WIDTH;
      continue;
    }
    const keyAlter = keyAccidentals.get(item.pitch.step) ?? 0;
    const drawsAccidental = item.accidental === 'show' || item.accidental === 'parens' || item.pitch.alter !== keyAlter;
    notes += NOTE_WIDTH + (drawsAccidental ? ACCIDENTAL_WIDTH : 0) + item.duration.dots * DOT_WIDTH + graceWidth(item, keyAccidentals, GRACE_WIDTH, ACCIDENTAL_WIDTH / 2) + chordExtra(item, keyAccidentals, NOTE_WIDTH, ACCIDENTAL_WIDTH);
  }

  let chords = 0;
  for (const chord of [...bar.chords, ...bar.annotations]) {
    chords += chord.text.length * CHORD_CHARACTER_WIDTH + CHORD_GAP;
  }

  return prefixWidth(score, prefix) + Math.max(notes, chords);
}

/**
 * The least a bar's music can be drawn in without glyphs touching (SIB2-153): the engraver's rigid width
 * per onset (notehead or rest, minimum gap, accidental, dots) plus its left and right padding, as a
 * conservative estimate in units — layout cannot measure glyphs (ADR-0015), so these are the engraver's
 * numbers rounded. Only ever used as a floor in `distribute`, and only for a bar that would otherwise
 * overflow its box, so a bar with room to spare is allocated exactly as before.
 */
const RIGID_NOTE = 19;
const RIGID_REST = 19;
const RIGID_ACCIDENTAL = 12;
const RIGID_DOT = 5;
const RIGID_GRACE = 13;
const RIGID_PADDING = 28;

export function rigidBarWidth(score: Score, bar: BarView, prefix: BarPrefix): number {
  const keyAccidentals = keySignatureAccidentals(score.meta.key);
  let width = RIGID_PADDING;
  for (const item of bar.items) {
    if (item.kind === 'rest') {
      width += RIGID_REST;
      continue;
    }
    const keyAlter = keyAccidentals.get(item.pitch.step) ?? 0;
    const drawsAccidental = item.accidental === 'show' || item.accidental === 'parens' || item.pitch.alter !== keyAlter;
    width += RIGID_NOTE + (drawsAccidental ? RIGID_ACCIDENTAL : 0) + item.duration.dots * RIGID_DOT + graceWidth(item, keyAccidentals, RIGID_GRACE, RIGID_ACCIDENTAL / 2) + chordExtra(item, keyAccidentals, RIGID_NOTE, RIGID_ACCIDENTAL);
  }
  return prefixWidth(score, prefix) + width;
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

function pickupWidth(score: Score, bar: BarView, prefix: BarPrefix, available: number): number {
  const prefixOnly = prefixWidth(score, prefix);
  const contents = estimateBarWidth(score, bar, prefix) - prefixOnly;
  const notes = Math.max(contents, MIN_PICKUP_NOTE_WIDTH);
  return Math.min(prefixOnly + notes, available * 0.35);
}

export interface AllocateOptions {
  /** The very first bar of the score carries the time signature. */
  isFirstSystem: boolean;
  /**
   * Whether this system's head bar draws the clef and key signature (SIB2-173). Separate from
   * `isFirstSystem` because the policy can drop them from later systems, which still start a line.
   */
  showSignatures: boolean;
  /**
   * What each bar is sized by. A multi-staff system (SIB2-227) sizes a bar by its **widest staff** for the weight and by
   * the **union of every staff and voice** for the rigid floor, because simultaneous notes share a column. Absent means
   * the bar itself, which is what every single-staff chart does, so its allocation is unchanged.
   */
  sizing?: BarSizing;
}

export interface BarSizing {
  /** The view whose `estimateBarWidth` is the bar's weight. */
  estimate: (bar: BarView) => BarView;
  /** The view whose `rigidBarWidth` is the bar's floor. */
  rigid: (bar: BarView) => BarView;
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
    const width = pickupWidth(score, options.sizing?.estimate(system.pickup) ?? system.pickup, prefix, available);
    allocated.push({
      bar: system.pickup,
      x,
      width,
      isPickup: true,
      headsSystem: true,
      prefix,
      prefixWidth: prefixWidth(score, prefix),
    });
    x += width;
    remaining -= width;
  }

  const prefixes: BarPrefix[] = system.bars.map((_, index) => ({
    // Clef and key signature repeat at the head of every system, unless the score's policy says otherwise.
    clef: index === 0 && system.pickup === null && options.showSignatures,
    keySignature: index === 0 && system.pickup === null && options.showSignatures,
    // One time signature per chart (ADR-0021), so it appears once, at the very start.
    timeSignature: index === 0 && options.isFirstSystem && system.pickup === null,
  }));

  // A system head with no clef (the signature policy dropped it, SIB2-173) still starts a line that
  // carries a bar number, and the first notehead would sit on it. Give the head a small lead-in so the
  // number clears the music. Nothing changes for a head that has its clef.
  const leadIns = prefixes.map((prefix, index) =>
    index === 0 && system.pickup === null && !prefix.clef && bar0Number(system) > 1 ? HEAD_LEAD_IN : 0,
  );

  const weights = system.bars.map(
    (bar, index) =>
      estimateBarWidth(score, options.sizing?.estimate(bar) ?? bar, prefixes[index] ?? noPrefix()) + (leadIns[index] ?? 0),
  );
  const mins = system.bars.map(
    (bar, index) =>
      rigidBarWidth(score, options.sizing?.rigid(bar) ?? bar, prefixes[index] ?? noPrefix()) + (leadIns[index] ?? 0),
  );
  const widths = withContentFloor(distribute(weights, remaining, spec), mins, remaining);

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
      headsSystem: index === 0 && system.pickup === null,
      prefix,
      prefixWidth: prefixWidth(score, prefix) + (leadIns[index] ?? 0),
    });
    x += width;
  }

  return allocated;
}

/** Room a prefix-less system head leaves for its bar number before the first note. */
const HEAD_LEAD_IN = 18;

function bar0Number(system: PlannedSystem): number {
  return system.bars[0]?.number ?? 0;
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

/**
 * Hold a bar at its rigid width when the grid share would make its glyphs collide (SIB2-153), and take
 * the difference from the bars that have room, in proportion to their surplus. Nothing changes unless
 * some bar falls below its floor, and if the floors cannot all be met the system keeps the plain
 * distribution: an overfull system runs long rather than being rearranged (ADR-0013).
 */
function withContentFloor(widths: readonly number[], mins: readonly number[], total: number): number[] {
  if (widths.every((width, index) => width >= (mins[index] ?? 0))) return [...widths];
  if (mins.reduce((sum, m) => sum + m, 0) > total) return [...widths];

  const result = widths.map((width, index) => Math.max(width, mins[index] ?? 0));
  const excess = result.reduce((sum, width) => sum + width, 0) - total;
  const donors = result.map((width, index) => Math.max(width - (mins[index] ?? 0), 0));
  const surplus = donors.reduce((sum, d) => sum + d, 0);
  if (excess <= 1e-9 || surplus <= 1e-9) return result;
  const take = Math.min(excess, surplus);
  return result.map((width, index) => width - (take * (donors[index] ?? 0)) / surplus);
}

/** What a note's grace notes add (SIB2-185): `perGrace` each, plus `accidental` for any that leave the key. */
function graceWidth(
  item: Note,
  keyAccidentals: ReadonlyMap<Step, Alter>,
  perGrace: number,
  accidental: number,
): number {
  let width = 0;
  for (const grace of item.graces ?? []) {
    const departs = grace.accidental === 'show' || grace.accidental === 'parens' || grace.pitch.alter !== (keyAccidentals.get(grace.pitch.step) ?? 0);
    width += perGrace + (departs ? accidental : 0);
  }
  return width;
}
