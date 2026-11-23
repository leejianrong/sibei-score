import { formatBeat } from '@sibei/model';
import type { Duration } from '@sibei/model';

/**
 * What the score view says out loud (SIB2-269): the sentences its `aria-live` status region carries, so a screen-reader
 * user hears what the sighted user sees change. Pure text over plain values, so the wording is unit-tested and the two
 * places that need it (a selection, a note-input caret) cannot phrase the same thing two ways.
 */

const VALUE_NAMES: Readonly<Record<number, string>> = {
  1: 'whole',
  2: 'half',
  4: 'quarter',
  8: 'eighth',
  16: 'sixteenth',
  32: 'thirty-second',
};

/** `quarter`, `dotted half`, `double-dotted eighth`. */
export function durationName(duration: Duration): string {
  const name = VALUE_NAMES[duration.value] ?? `1/${duration.value}`;
  return duration.dots === 0 ? name : `${duration.dots === 1 ? 'dotted' : 'double-dotted'} ${name}`;
}

export interface ItemWords {
  bar: number;
  beat: number;
  kind: 'note' | 'rest';
  /** A note's written pitch, `G4`; a chord's lowest. */
  pitch?: string;
  /** How many pitches a stacked chord has beyond the first. */
  extraTones?: number;
  duration: Duration;
  /** The staff and voice, said only when the chart has more than one lane. */
  lane?: string;
}

/** `Bar 3, beat 2, note G4, quarter`. */
export function describeItem(item: ItemWords): string {
  const what =
    item.kind === 'rest'
      ? 'rest'
      : item.extraTones !== undefined && item.extraTones > 0
        ? `chord of ${item.extraTones + 1} notes from ${item.pitch ?? ''}`
        : `note ${item.pitch ?? ''}`;
  const parts = [`Bar ${item.bar}`, `beat ${formatBeat(item.beat)}`, what, durationName(item.duration)];
  if (item.lane !== undefined) parts.push(item.lane);
  return parts.join(', ');
}

/** `Bar 3, chord Cmaj7, beat 1`, or the empty slot a click would fill. */
export function describeChord(bar: number, beat: number, text: string | null): string {
  return text === null || text === '' ? `Bar ${bar}, beat ${formatBeat(beat)}, empty chord slot` : `Bar ${bar}, chord ${text}, beat ${formatBeat(beat)}`;
}

export function describeBar(bar: number): string {
  return `Bar ${bar} selected`;
}

export function describeMany(count: number): string {
  return `${count} items selected`;
}

/** `Deleted 3 items`, `Deleted 1 item`. */
export function deletedWords(count: number): string {
  return `Deleted ${count} ${count === 1 ? 'item' : 'items'}`;
}
