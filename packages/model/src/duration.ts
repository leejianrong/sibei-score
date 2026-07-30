import type { Bar, BarItem, Duration, Id, TimeSignature, Tuplet } from './score.js';

/**
 * Ticks are the model's only unit of musical time. 480 per quarter keeps every
 * duration this product supports an exact integer, including a double-dotted
 * thirty-second inside a triplet.
 */
export const TICKS_PER_QUARTER = 480;

export const TICKS_PER_WHOLE = TICKS_PER_QUARTER * 4;

/** Ticks for a duration on its own, ignoring any tuplet it belongs to. */
export function durationTicks(duration: Duration): number {
  const base = TICKS_PER_WHOLE / duration.value;
  // A dot adds half of what precedes it: 1 dot is 3/2, 2 dots are 7/4.
  const numerator = 2 ** (duration.dots + 1) - 1;
  const denominator = 2 ** duration.dots;
  return (base * numerator) / denominator;
}

/** The tuplet an item belongs to, or null. The bar owns the grouping. */
export function tupletOf(itemId: Id, bar: Bar): Tuplet | null {
  return bar.tuplets.find((t) => t.memberIds.includes(itemId)) ?? null;
}

/** Ticks an item actually occupies, with tuplet scaling applied. */
export function itemTicks(item: BarItem, bar: Bar): number {
  const plain = durationTicks(item.duration);
  const tuplet = tupletOf(item.id, bar);
  if (tuplet === null) return plain;
  return (plain * tuplet.normal) / tuplet.actual;
}

/** Ticks a full bar of the given time signature holds. */
export function barCapacity(time: TimeSignature): number {
  return (time.beats * TICKS_PER_WHOLE) / time.beatValue;
}

/** Ticks in one beat of the given time signature. */
export function beatTicks(time: TimeSignature): number {
  return TICKS_PER_WHOLE / time.beatValue;
}

/**
 * The 1-based beat an onset falls on, as printed by the text projection and
 * accepted by the CLI: `bar12.beat3` (ADR-0007). Fractional between beats.
 */
export function beatOfOnset(onset: number, time: TimeSignature): number {
  return onset / beatTicks(time) + 1;
}

/** Ticks from the start of the bar for a 1-based beat position. */
export function onsetOfBeat(beat: number, time: TimeSignature): number {
  return (beat - 1) * beatTicks(time);
}
