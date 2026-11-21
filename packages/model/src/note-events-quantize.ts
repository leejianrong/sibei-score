/**
 * The NoteEvents quantizer: seconds to bars on the tick grid (ADR-0040 #4, #5).
 *
 * Pure and deterministic — no clock, no randomness, no I/O. Input is a validated monophonic
 * {@link NoteEvents} (the audio engine's contract, times in seconds); output is per-bar items on the
 * model's tick grid with rests filling every gap, plus the warnings the guesses produced. It makes no
 * notation decisions beyond rhythm and barring: pitch spelling, key and review flags are the mapper's
 * job (`note-events-map.ts`), and splitting a tick count into legal durations and ties is too.
 *
 * Deliberately simple (a correct simple quantizer over a clever one):
 * - **The grid is the beat grid** when two or more beats are given: a note's time is converted to a
 *   fractional beat by interpolating between the tracker's beats, then snapped to a sixteenth
 *   ({@link GRID_TICKS}). Halfway between two grid points rounds *down*, so the result is deterministic.
 * - **No beat grid** → one constant tempo from the median inter-onset interval, refined once by
 *   least squares, 4/4, the first note on the downbeat, and a `no-beat-grid` warning that the barring
 *   is a guess.
 * - Downbeat flags set the bar length and where bar 1 starts. The real transcriber marks **every**
 *   `is_downbeat` null (it finds beats, not bar lines), so without flags it is 4/4 and bar 1 is assumed
 *   to start on the beat nearest the first note, with a `no-downbeats` warning the mapper turns into a
 *   flag on bar 1 — a draft assumption the user corrects, never a fact.
 * - A note that starts in the bar before the first downbeat makes a **pickup** (bar 0). Leading silence
 *   is trimmed: the draft begins at the bar of the first note.
 * - It never rejects and never repairs a performance: a bar the rhythm does not fill is the mapper's
 *   to flag (ADR-0013). Every bar built here sums to the meter by construction except a pickup.
 *
 * Swing-feel detection, tuplets, polyphony and tempo changes are out of scope; a swung eighth snaps to
 * the nearest sixteenth and the user corrects it.
 */

import { TICKS_PER_QUARTER, barCapacity } from './duration.js';
import type { NoteEvents } from './note-events.js';
import type { TimeSignature } from './score.js';

/** The share of a note's heard length added back before its end snaps (see the quantizer). */
const ARTICULATION = 0.08;

/** The quantization grid: a sixteenth note. */
export const GRID_TICKS = TICKS_PER_QUARTER / 4;

export interface QuantizedItem {
  kind: 'note' | 'rest';
  /** Ticks from the start of the bar. */
  onset: number;
  /** Ticks. Never crosses the bar line: a note that does is split and tied. */
  ticks: number;
  /** MIDI pitch; null for a rest. */
  midi: number | null;
  /** The engine's 0-1 confidence; null for a rest. */
  confidence: number | null;
  /** The NoteEvents note this came from (both halves of a split note share it); null for a rest. */
  sourceId: string | null;
  /** This note continues one that began in the previous bar. */
  tiedFromPrevious: boolean;
  /** This note continues into the next bar. */
  tiedToNext: boolean;
}

export interface QuantizedBar {
  /** 0 for a pickup, otherwise 1-based. */
  number: number;
  items: QuantizedItem[];
}

export interface QuantizeWarning {
  code:
    | 'no-beat-grid'
    | 'no-downbeats'
    | 'overlap'
    | 'collapsed-onset'
    | 'no-notes';
  message: string;
  /** Where in the recording, when it has a place. */
  timeS?: number;
  /** The NoteEvents note it is about, when it is about one (the mapper flags it for review). */
  noteId?: string;
}

export interface QuantizeResult {
  time: TimeSignature;
  /** Beats per minute implied by the grid (inferred or the median of the tracker's). */
  tempoBpm: number;
  bars: QuantizedBar[];
  warnings: QuantizeWarning[];
}

interface Beat {
  t: number;
  down: boolean | null;
}

interface Placed {
  id: string;
  midi: number;
  confidence: number;
  start: number; // ticks on the global axis, snapped
  end: number;
  t: number; // onset seconds, for warnings
}

export function quantizeNoteEvents(events: NoteEvents): QuantizeResult {
  const warnings: QuantizeWarning[] = [];
  const notes = [...events.notes].sort((a, b) => a.onset_s - b.onset_s || a.pitch - b.pitch || cmp(a.id, b.id));

  const given = events.beats
    .map((b): Beat => ({ t: b.t_s, down: b.is_downbeat ?? null }))
    .sort((a, b) => a.t - b.t);
  const usable = given.length >= 2 && given[given.length - 1]!.t > given[0]!.t;

  let beats: Beat[];
  if (usable) {
    beats = given;
  } else {
    warnings.push({
      code: 'no-beat-grid',
      message: 'no usable beat grid: tempo was inferred from the note onsets and bar lines are a guess',
    });
    beats = inferBeats(notes.map((n) => n.onset_s), events.source.duration_s, Math.max(...notes.map((n) => n.offset_s), 0));
  }

  // Bar length from the downbeat flags, else 4/4 from the first beat.
  const downIdx = beats.flatMap((b, i) => (b.down === true ? [i] : []));
  let beatsPerBar = 4;
  let originIdx = 0;
  if (downIdx.length >= 1) {
    originIdx = downIdx[0]!;
    if (downIdx.length >= 2) {
      const gap = modeOf(downIdx.slice(1).map((d, i) => d - downIdx[i]!));
      if (gap >= 2 && gap <= 7) beatsPerBar = gap;
    }
  } else if (usable) {
    // No downbeat flags: bar 1 starts on the beat nearest the first note (a draft assumption).
    const first = notes.length === 0 ? 0 : notes[0]!.onset_s;
    let best = 0;
    for (let i = 1; i < beats.length; i++) {
      if (Math.abs(beats[i]!.t - first) < Math.abs(beats[best]!.t - first)) best = i;
    }
    originIdx = best;
    warnings.push({
      code: 'no-downbeats',
      message: 'the beat grid marks no downbeats: assumed 4/4 with bar 1 on the beat nearest the first note',
    });
  }
  const time: TimeSignature = { beats: beatsPerBar, beatValue: 4 };
  const capacity = barCapacity(time);

  if (notes.length === 0) {
    warnings.push({ code: 'no-notes', message: 'the document has no notes' });
    return { time, tempoBpm: tempoOf(beats), bars: [], warnings };
  }

  // Place every note on the global tick axis (0 = the origin downbeat), snapped.
  const toTicks = (t: number): number => fractionalBeat(beats, t, originIdx) * TICKS_PER_QUARTER;
  const placed: Placed[] = [];
  for (const n of notes) {
    const start = snap(toTicks(n.onset_s));
    // A performed note sounds a little shorter than it is written (decay, breath, the articulation gap),
    // so the offset is nudged later by a small share of what was heard, at most half a grid step, before
    // it snaps. Without it a held half note that sounds 92% as long snaps down and leaves a phantom rest.
    const heard = toTicks(n.offset_s) - toTicks(n.onset_s);
    const end = Math.max(snap(toTicks(n.offset_s) + Math.min(GRID_TICKS / 2, ARTICULATION * heard)), start + GRID_TICKS);
    const last = placed[placed.length - 1];
    if (last !== undefined && last.start === start) {
      // Monophonic: two notes cannot share a grid point. Keep the more confident (the earlier on a tie).
      warnings.push({
        code: 'collapsed-onset',
        message: `notes ${last.id} and ${n.id} landed on the same grid point; kept the more confident`,
        timeS: n.onset_s,
        noteId: n.confidence > last.confidence ? n.id : last.id,
      });
      if (n.confidence > last.confidence) placed[placed.length - 1] = { id: n.id, midi: n.pitch, confidence: n.confidence, start, end, t: n.onset_s };
      continue;
    }
    placed.push({ id: n.id, midi: n.pitch, confidence: n.confidence, start, end, t: n.onset_s });
  }
  // One line: a note ends where the next begins.
  for (let i = 0; i + 1 < placed.length; i++) {
    const a = placed[i]!;
    const next = placed[i + 1]!;
    // A one-step gap after a note that is long next to it is legato, not a rest.
    const gap = next.start - a.end;
    if (gap === GRID_TICKS && gap <= 0.15 * (next.start - a.start)) a.end = next.start;
    if (a.end > next.start) {
      if (a.end - next.start > GRID_TICKS) {
        warnings.push({ code: 'overlap', message: `note ${a.id} overlaps ${next.id}; shortened to one line`, timeS: next.t, noteId: a.id });
      }
      a.end = next.start;
    }
  }

  // Bars from the first note's bar to the last note's; leading silence is trimmed.
  const firstBar = Math.floor(placed[0]!.start / capacity);
  const lastBar = Math.floor((placed[placed.length - 1]!.end - 1) / capacity);
  const pickup = firstBar === -1;
  const numberOf = (index: number): number => (pickup ? index + 1 : index - firstBar + 1);
  const bars: QuantizedBar[] = [];
  for (let index = firstBar; index <= lastBar; index++) bars.push({ number: numberOf(index), items: [] });

  // Walk the line, cutting at bar lines and filling gaps with rests.
  // A pickup begins at its first note; any other first bar is filled with rests from its bar line.
  let cursor = pickup ? placed[0]!.start : firstBar * capacity;
  const push = (from: number, to: number, note: Placed | null): void => {
    let at = from;
    while (at < to) {
      const index = Math.floor(at / capacity);
      const barEnd = (index + 1) * capacity;
      const stop = Math.min(to, barEnd);
      const bar = bars[index - firstBar]!;
      bar.items.push({
        kind: note === null ? 'rest' : 'note',
        onset: at - index * capacity,
        ticks: stop - at,
        midi: note?.midi ?? null,
        confidence: note?.confidence ?? null,
        sourceId: note?.id ?? null,
        tiedFromPrevious: note !== null && at > from,
        tiedToNext: note !== null && stop < to,
      });
      at = stop;
    }
  };
  for (const n of placed) {
    if (n.start > cursor) push(cursor, n.start, null);
    push(n.start, n.end, n);
    cursor = n.end;
  }
  // Fill the last bar to the meter.
  const lastEnd = (lastBar + 1) * capacity;
  if (cursor < lastEnd) push(cursor, lastEnd, null);

  if (pickup) {
    // Rebase the short pickup bar so its first note sits at onset 0.
    const shift = placed[0]!.start + capacity;
    for (const item of bars[0]!.items) item.onset -= shift;
  }

  return { time, tempoBpm: tempoOf(beats), bars, warnings };
}

/** Round to the grid; exactly halfway goes down (deterministic). */
function snap(ticks: number): number {
  return Math.ceil(ticks / GRID_TICKS - 0.5) * GRID_TICKS;
}

/** Fractional beat position of time `t`, relative to the beat at `originIdx`, by interpolation. */
function fractionalBeat(beats: readonly Beat[], t: number, originIdx: number): number {
  const n = beats.length;
  let i: number;
  if (t <= beats[0]!.t) i = 0;
  else if (t >= beats[n - 1]!.t) i = n - 2;
  else {
    i = 0;
    while (beats[i + 1]!.t <= t) i++;
  }
  const a = beats[i]!.t;
  const b = beats[i + 1]!.t;
  return i + (t - a) / (b - a) - originIdx;
}

/** A constant-tempo grid from the note onsets (no tracker beats): median IOI, one least-squares pass. */
function inferBeats(onsets: readonly number[], durationS: number, lastOffsetS: number): Beat[] {
  const sorted = [...onsets].sort((a, b) => a - b);
  const t0 = sorted[0] ?? 0;
  const iois: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i]! - sorted[i - 1]!;
    if (d > 0.08) iois.push(d);
  }
  let period = iois.length === 0 ? 0.5 : median(iois);
  // Fold into a plausible beat: 67-133 bpm.
  while (period < 0.45) period *= 2;
  while (period >= 0.9) period /= 2;

  // Refine: fit onset = origin + k * (period/4) over the sixteenth index each onset lands on.
  if (sorted.length >= 3) {
    const sixteenth = period / 4;
    const ks = sorted.map((t) => Math.round((t - t0) / sixteenth));
    const n = ks.length;
    const meanK = ks.reduce((s, k) => s + k, 0) / n;
    const meanT = sorted.reduce((s, t) => s + t, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (ks[i]! - meanK) * (sorted[i]! - meanT);
      den += (ks[i]! - meanK) ** 2;
    }
    if (den > 0 && num > 0) period = (num / den) * 4;
  }

  const end = Math.max(durationS, lastOffsetS, t0) + 4 * period;
  const beats: Beat[] = [];
  for (let k = 0; t0 + k * period <= end; k++) beats.push({ t: t0 + k * period, down: k % 4 === 0 });
  return beats;
}

function tempoOf(beats: readonly Beat[]): number {
  if (beats.length < 2) return 120;
  const gaps = beats.slice(1).map((b, i) => b.t - beats[i]!.t).filter((g) => g > 0);
  return gaps.length === 0 ? 120 : Math.round((60 / median(gaps)) * 10) / 10;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The most common value; the smaller on a tie. */
function modeOf(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0]!;
  for (const [v, c] of counts) {
    const bc = counts.get(best)!;
    if (c > bc || (c === bc && v < best)) best = v;
  }
  return best;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
