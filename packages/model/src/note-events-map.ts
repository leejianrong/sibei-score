/**
 * Map a NoteEvents document onto a `Score` draft (ADR-0040 #6, ADR-0019).
 *
 * Pure and framework-free, like `omr-map.ts`. It quantizes (`note-events-quantize.ts`), infers the key,
 * spells pitches through the existing spelling engine, splits each tick span into legal durations with
 * ties, and turns every doubt into a review flag the OMR draft already shows:
 *
 * - a note under {@link NOTE_CONFIDENCE_FLOOR} (the transcriber's voicing probability) is flagged
 *   `low-confidence` and carries its confidence, so `sbscore show` prints `c5/4!40` and the browser
 *   highlights it, exactly as for an OMR note (ADR-0019);
 * - a note a NoteEvents `low_confidence` / `clipping` warning points at, or one the quantizer had to
 *   truncate or merge, is flagged the same way;
 * - **bar 1 is flagged when the barring is a guess** (no downbeats, or no beat grid at all): the real
 *   transcriber marks every `is_downbeat` null, so where bar 1 starts is a draft assumption, never a
 *   fact;
 * - metric validity is derived as ever (ADR-0013); the quantizer's bars fill the meter by construction,
 *   so nothing is rejected or repaired here.
 *
 * Every warning (the document's and the quantizer's) comes back as a `diagnostics` string for the
 * import record. A silent or empty document is **not an error**: it maps to a draft with one empty bar
 * and its warnings kept (ADR-0040 amendment).
 *
 * No chords are recognised from audio (out of scope), no sections are detected (ADR-0021).
 */

import { TICKS_PER_WHOLE, durationTicks } from './duration.js';
import { makeBar, makeNote, makeRest, makeScore } from './build.js';
import type { NoteEvents } from './note-events.js';
import { mapDrumEventsToScore } from './note-events-drums.js';
import { GRID_TICKS, quantizeNoteEvents } from './note-events-quantize.js';
import type { QuantizedItem } from './note-events-quantize.js';
import { SEMITONE_OF_STEP } from './pitch.js';
import { spellPitchAt } from './spelling.js';
import type { Bar, BarItem, Dots, Duration, Id, KeySignature, Mode, NoteValue, Review, Score, Step, Alter } from './score.js';

/** Below this transcriber confidence a note is flagged for review (ADR-0019). */
export const NOTE_CONFIDENCE_FLOOR = 0.6;

export interface NoteEventsMapOptions {
  /** The id the new score is created under (the runner mints it from the job). */
  id: Id;
  title?: string;
  composer?: string;
}

export interface NoteEventsDraft {
  score: Score;
  /** Human-readable notes for the import record: every warning, plus what was inferred. */
  diagnostics: string[];
}

export function mapNoteEventsToScore(events: NoteEvents, options: NoteEventsMapOptions): NoteEventsDraft {
  // A drum track is polyphonic, many instruments at one moment: its own mapper, onto a percussion staff (ADR-0041 slice 6).
  if (events.instrument === 'drums') return mapDrumEventsToScore(events, options);
  const quantized = quantizeNoteEvents(events);
  const key = inferKey(quantized.bars.flatMap((b) => b.items));
  const flaggedIds = flaggedSourceIds(events, quantized.warnings);
  const guessedBarring = quantized.warnings.some((w) => w.code === 'no-downbeats' || w.code === 'no-beat-grid');

  const bars: Bar[] = quantized.bars.map((qb, index) => {
    const items: BarItem[] = [];
    let notes = 0;
    let rests = 0;
    for (const q of qb.items) {
      const pieces = splitTicks(q.onset, q.ticks);
      let at = q.onset;
      pieces.forEach((duration, i) => {
        if (q.kind === 'rest') {
          rests += 1;
          items.push(makeRest({ id: `rest-${qb.number}-${rests}`, onset: at, duration }));
        } else {
          notes += 1;
          const continues = i < pieces.length - 1 || q.tiedToNext;
          const follows = i > 0 || q.tiedFromPrevious;
          const unsure = q.confidence! < NOTE_CONFIDENCE_FLOOR || flaggedIds.has(q.sourceId!);
          items.push(
            makeNote({
              id: `note-${qb.number}-${notes}`,
              onset: at,
              duration,
              pitch: spellPitchAt(q.midi!, key),
              tie: continues ? (follows ? 'both' : 'start') : follows ? 'stop' : 'none',
              confidence: q.confidence,
              ...(unsure ? { review: flag() } : {}),
            }),
          );
        }
        at += durationTicks(duration);
      });
    }
    return makeBar({
      id: `bar-${qb.number}`,
      number: qb.number,
      items,
      ...(index === 0 && guessedBarring ? { review: flag() } : {}),
    });
  });

  const score = makeScore({
    id: options.id,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.composer === undefined ? {} : { composer: options.composer }),
    key,
    time: quantized.time,
    // A silent document still drafts: one empty bar, warnings kept.
    bars: bars.length > 0 ? bars : [makeBar({ id: 'bar-1', number: 1 })],
    sections: [],
  });

  const diagnostics = [
    ...events.warnings.map((w) => `${w.code}: ${w.message}${w.t_s == null ? '' : ` (at ${w.t_s}s)`}`),
    ...quantized.warnings.map((w) => `${w.code}: ${w.message}${w.timeS === undefined ? '' : ` (at ${w.timeS}s)`}`),
  ];
  if (quantized.bars.length > 0) {
    diagnostics.push(`inferred: ${keyName(key)}, ${quantized.time.beats}/${quantized.time.beatValue}, about ${quantized.tempoBpm} bpm`);
  }
  return { score, diagnostics };
}

function flag(): Review {
  return { flagged: true, reasons: ['low-confidence'] };
}

/** Source note ids a warning points at: a quantizer-named note, or those sounding at a flagged time. */
function flaggedSourceIds(events: NoteEvents, quantizeWarnings: readonly { noteId?: string }[]): Set<string> {
  const ids = new Set<string>();
  for (const w of quantizeWarnings) if (w.noteId !== undefined) ids.add(w.noteId);
  for (const w of events.warnings) {
    if (w.t_s == null || (w.code !== 'low_confidence' && w.code !== 'clipping')) continue;
    for (const n of events.notes) {
      if (w.t_s >= n.onset_s - 0.05 && w.t_s <= n.offset_s + 0.05) ids.add(n.id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Durations: a tick span becomes legal note values, tied
// ---------------------------------------------------------------------------

const VALUES: readonly NoteValue[] = [1, 2, 4, 8, 16];
const CANDIDATES: ReadonlyArray<{ duration: Duration; ticks: number; base: number }> = VALUES.flatMap((value) =>
  ([0, 1] as Dots[]).map((dots) => {
    const duration: Duration = { value, dots };
    return { duration, ticks: durationTicks(duration), base: TICKS_PER_WHOLE / value };
  }),
).sort((a, b) => b.ticks - a.ticks);

/**
 * Greedy split of `ticks` starting at `onset` into legal durations, largest first. A piece up to a half
 * note may start on any sixteenth, which keeps syncopation as one note (a swung jazz line is mostly
 * that); a longer one (dotted half, whole) must start on a half-bar point.
 * Total for any multiple of a sixteenth, which the quantizer guarantees.
 */
export function splitTicks(onset: number, ticks: number): Duration[] {
  const out: Duration[] = [];
  let at = onset;
  let left = ticks;
  while (left > 0) {
    const pick = CANDIDATES.find((c) => c.ticks <= left && at % (c.ticks <= 960 ? GRID_TICKS : 960) === 0);
    if (pick === undefined) throw new Error(`cannot split ${left} ticks at ${at}`);
    out.push(pick.duration);
    at += pick.ticks;
    left -= pick.ticks;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Key: the scale that best fits the pitch-class histogram
// ---------------------------------------------------------------------------

/** Candidate keys, fewest accidentals first, major before its relative minor on a tie. */
const KEYS: readonly KeySignature[] = (() => {
  const major: Array<[Step, Alter]> = [['C', 0], ['G', 0], ['F', 0], ['D', 0], ['B', -1], ['A', 0], ['E', -1], ['E', 0], ['A', -1], ['B', 0], ['D', -1], ['F', 1], ['G', -1]];
  const minor: Array<[Step, Alter]> = [['A', 0], ['E', 0], ['D', 0], ['B', 0], ['G', 0], ['F', 1], ['C', 0], ['C', 1], ['F', 0], ['G', 1], ['B', -1], ['D', 1], ['E', -1]];
  return major.flatMap(([tonic, alter], i) => [
    { tonic, alter, mode: 'major' as Mode },
    { tonic: minor[i]![0], alter: minor[i]![1], mode: 'minor' as Mode },
  ]);
})();

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

/** The key whose scale covers the most sounding time, its tonic triad counting extra. */
export function inferKey(items: readonly QuantizedItem[]): KeySignature {
  const weight = new Array<number>(12).fill(0);
  for (const i of items) if (i.midi !== null) weight[i.midi % 12]! += i.ticks;
  const total = weight.reduce((a, b) => a + b, 0);
  if (total === 0) return { tonic: 'C', alter: 0, mode: 'major' };

  let best = KEYS[0]!;
  let bestScore = -Infinity;
  for (const key of KEYS) {
    const tonic = (SEMITONE_OF_STEP[key.tonic] + key.alter + 12) % 12;
    const scale = key.mode === 'major' ? MAJOR_SCALE : MINOR_SCALE;
    let score = 0;
    for (const degree of scale) score += weight[(tonic + degree) % 12]!;
    // A minor melody's raised seventh is still in the key.
    if (key.mode === 'minor') score += weight[(tonic + 11) % 12]! * 0.5;
    // Tonic-triad evidence breaks the tie between a major scale and its relative minor and modes.
    const third = key.mode === 'major' ? 4 : 3;
    score += 0.5 * (weight[tonic]! + weight[(tonic + third) % 12]! + weight[(tonic + 7) % 12]!);
    if (score > bestScore + 1e-9) {
      best = key;
      bestScore = score;
    }
  }
  return best;
}

function keyName(key: KeySignature): string {
  return `${key.tonic}${key.alter === 1 ? '#' : key.alter === -1 ? 'b' : ''} ${key.mode}`;
}
