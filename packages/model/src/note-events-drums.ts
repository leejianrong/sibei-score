/**
 * Map a drum NoteEvents document onto a percussion-staff draft (ADR-0040, ADR-0041 slice 6).
 *
 * The melody mapper (`note-events-map.ts`) is monophonic: one line, a note ends where the next begins. A drum track is
 * the opposite, many instruments struck at once, each hit a moment rather than a length. So this is its own module,
 * sharing only the beat grid (`beatGrid`) and the snap with the melody quantizer:
 *
 * - each note is a **hit**: its drum (`drumOfNoteEvent`: a recognised `drum_class`, else the General MIDI key) and the
 *   sixteenth it snaps to. Two hits of one drum on one sixteenth collapse to the more confident, with a warning. An
 *   unknown key is kept as a generic percussion hit, flagged for review, and named in the diagnostics.
 * - hits are **voiced** the way a drum chart is (`drums.ts`): the hands in voice 1 (stems up), the feet in voice 2
 *   (stems down). A voice holds one item per onset, so a hit that shares a moment with another of its side goes to
 *   voice 3 (hands) or voice 4 (feet); the drum with the most hits in the bar keeps the first voice, so a hi-hat
 *   ostinato stays in voice 1 and the snare under it takes voice 3. Voice 3 and 4 appear only in bars that need them.
 * - a hit has no length in the recording that matters, so it is **written** as the longest quarter, eighth or sixteenth
 *   that fits before the voice's next hit, followed by a rest for the rest of the gap.
 * - the draft is a review draft like every audio import (ADR-0019): a hit under {@link NOTE_CONFIDENCE_FLOOR} is
 *   flagged, bar 1 is flagged when the barring is a guess, and every warning comes back as a diagnostic.
 */

import { makeBar, makeDrumNote, makeRest } from './build.js';
import { makeStaffedScore } from './build-staves.js';
import type { VoiceInit } from './build-staves.js';
import { TICKS_PER_QUARTER, durationTicks } from './duration.js';
import { drumById, drumOfNoteEvent } from './drums.js';
import type { DrumId } from './drums.js';
import type { NoteEvents } from './note-events.js';
import type { NoteEventsDraft, NoteEventsMapOptions } from './note-events-map.js';
import { GRID_TICKS, gridOf, onsetBias, snap } from './note-events-quantize.js';
import type { BarSpan } from './note-events-quantize.js';
import type { BarItem, Dots, Duration, NoteValue, Review, Score } from './score.js';

/** The same floor as the melody mapper's (kept here to avoid an import cycle with it). */
const CONFIDENCE_FLOOR = 0.6;

/** How many hits one onset can hold on a side: voices 1 and 3 for the hands, 2 and 4 for the feet. */
const VOICES_PER_SIDE = 2;

interface Hit {
  sourceId: string;
  drum: DrumId;
  tick: number;
  confidence: number;
  unsure: boolean;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function flag(): Review {
  return { flagged: true, reasons: ['low-confidence'] };
}

/** A tick span to legal rests, largest first, each starting on its own alignment (a quarter on a beat, else a grid step). */
export function restPieces(onset: number, ticks: number): Duration[] {
  const out: Duration[] = [];
  let at = onset;
  let left = ticks;
  // value, dots, ticks, and the tick multiple the rest must start on (a half on a half-bar, a quarter on a beat...).
  const sizes: Array<[NoteValue, Dots, number, number]> = [
    [1, 0, 1920, 1920],
    [2, 1, 1440, 960],
    [2, 0, 960, 960],
    [4, 1, 720, 480],
    [4, 0, 480, 480],
    [8, 1, 360, 240],
    [8, 0, 240, 240],
    [16, 0, 120, 120],
  ];
  while (left > 0) {
    const pick = sizes.find(([, , t, align]) => t <= left && at % align === 0)!;
    out.push({ value: pick[0], dots: pick[1] });
    at += pick[2];
    left -= pick[2];
  }
  return out;
}

/** The length a hit is written at: the longest of a quarter, eighth or sixteenth that fits the gap and starts aligned. */
function hitTicks(onset: number, gap: number): number {
  for (const ticks of [TICKS_PER_QUARTER, TICKS_PER_QUARTER / 2, TICKS_PER_QUARTER / 4]) {
    if (ticks <= gap && onset % ticks === 0) return ticks;
  }
  return Math.min(gap, GRID_TICKS);
}

function durationOfTicks(ticks: number): Duration {
  const value = (TICKS_PER_QUARTER * 4) / ticks;
  return { value: value as NoteValue, dots: 0 };
}

export function mapDrumEventsToScore(events: NoteEvents, options: NoteEventsMapOptions): NoteEventsDraft {
  const notes = [...events.notes].sort((a, b) => a.onset_s - b.onset_s || a.pitch - b.pitch || cmp(a.id, b.id));
  const grid = gridOf(events, notes, options.shared);
  const warnings = [...grid.warnings];
  const diagnostics: string[] = [];
  const { time, capacity } = grid;

  // Hits on the tick axis.
  const { bias } = onsetBias(notes.map((n) => grid.toTicks(n.onset_s)));
  const lowConfidenceTimes = events.warnings
    .filter((w) => w.t_s != null && (w.code === 'low_confidence' || w.code === 'clipping'))
    .map((w) => w.t_s as number);
  const hits = new Map<string, Hit>();
  const unknownKeys = new Set<number>();
  for (const n of notes) {
    const named = drumOfNoteEvent(n.pitch, n.drum_class);
    if (named === null) unknownKeys.add(n.pitch);
    const drum = named ?? 'percussion';
    const tick = snap(grid.toTicks(n.onset_s) - bias);
    const unsure =
      named === null ||
      n.confidence < CONFIDENCE_FLOOR ||
      lowConfidenceTimes.some((t) => t >= n.onset_s - 0.05 && t <= n.offset_s + 0.05);
    const key = `${drum}@${tick}`;
    const held = hits.get(key);
    if (held !== undefined) {
      warnings.push({
        code: 'collapsed-onset',
        message: `hits ${held.sourceId} and ${n.id} (${drum}) landed on the same grid point; kept the more confident`,
        timeS: n.onset_s,
        noteId: n.confidence > held.confidence ? n.id : held.sourceId,
      });
      if (n.confidence <= held.confidence) continue;
    }
    hits.set(key, { sourceId: n.id, drum, tick, confidence: n.confidence, unsure });
  }
  for (const key of [...unknownKeys].sort((a, b) => a - b)) {
    diagnostics.push(`unknown-drum: no drum for key ${key}; kept as generic percussion, flagged for review`);
  }

  const all = [...hits.values()].sort((a, b) => a.tick - b.tick || cmp(a.sourceId, b.sourceId));

  if (all.length === 0) {
    warnings.push({ code: 'no-notes', message: 'the document has no notes' });
    return finish(empty(options), warnings, events, diagnostics, undefined);
  }

  // Bars from the first hit's bar to the last hit's; leading silence is trimmed. A hit before the first downbeat
  // makes a short pickup (bar 0) that begins at that hit.
  const own: BarSpan = {
    firstBar: Math.floor(all[0]!.tick / capacity),
    lastBar: Math.floor(all[all.length - 1]!.tick / capacity),
    pickupStart: all[0]!.tick,
  };
  const { firstBar, lastBar, pickupStart } = options.shared?.span ?? own;
  const pickup = firstBar === -1;
  const spans: Array<{ number: number; start: number; length: number }> = [];
  for (let index = firstBar; index <= lastBar; index += 1) {
    const number = pickup ? index + 1 : index - firstBar + 1;
    if (pickup && index === -1) spans.push({ number, start: pickupStart, length: -pickupStart });
    else spans.push({ number, start: index * capacity, length: capacity });
  }

  const guessedBarring = warnings.some((w) => w.code === 'no-downbeats' || w.code === 'no-beat-grid');
  const barViews = spans.map((span, index) =>
    makeBar({
      id: `bar-${span.number}`,
      number: span.number,
      ...(index === 0 && guessedBarring ? { review: flag() } : {}),
    }),
  );

  const staffBars: Array<VoiceInit | VoiceInit[]> = spans.map((span) => {
    const inBar = all.filter((h) => h.tick >= span.start && h.tick < span.start + span.length);
    const voices = inBar.length === 0 ? [[]] : voicesOf(inBar);
    const serial = { notes: 0, rests: 0 };
    const built = voices.map((voiceHits): VoiceInit => {
      const items: BarItem[] = [];
      let cursor = 0;
      const rest = (from: number, ticks: number): void => {
        let at = from;
        for (const duration of restPieces(from, ticks)) {
          serial.rests += 1;
          items.push(makeRest({ id: `rest-${span.number}-${serial.rests}`, onset: at, duration }));
          at += durationTicks(duration);
        }
      };
      // A bar with no hit at all is a rest, as the melody mapper fills its silent bars.
      if (inBar.length === 0) rest(0, span.length);
      voiceHits.forEach((hit, i) => {
        const onset = hit.tick - span.start;
        if (onset > cursor) rest(cursor, onset - cursor);
        const next = voiceHits[i + 1];
        const gap = (next === undefined ? span.length : next.tick - span.start) - onset;
        const ticks = hitTicks(onset, gap);
        serial.notes += 1;
        items.push(
          makeDrumNote({
            id: `note-${span.number}-${serial.notes}`,
            onset,
            duration: durationOfTicks(ticks),
            drum: hit.drum,
            confidence: hit.confidence,
            ...(hit.unsure ? { review: flag() } : {}),
          }),
        );
        cursor = onset + ticks;
        if (cursor < onset + gap) {
          rest(cursor, onset + gap - cursor);
          cursor = onset + gap;
        }
      });
      return { items };
    });
    return built.length === 1 ? built[0]! : built;
  });

  const score = makeStaffedScore({
    id: options.id,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.composer === undefined ? {} : { composer: options.composer }),
    time,
    bars: barViews,
    parts: [{ name: 'Drums', staves: [{ type: 'percussion', bars: staffBars }] }],
  });
  return { ...finish(score, warnings, events, diagnostics, grid.tempoBpm), span: own };
}

function empty(options: NoteEventsMapOptions): Score {
  return makeStaffedScore({
    id: options.id,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.composer === undefined ? {} : { composer: options.composer }),
    bars: [makeBar({ id: 'bar-1', number: 1 })],
    parts: [{ name: 'Drums', staves: [{ type: 'percussion', bars: [] }] }],
  });
}

function finish(
  score: Score,
  warnings: ReadonlyArray<{ code: string; message: string; timeS?: number }>,
  events: NoteEvents,
  diagnostics: string[],
  tempoBpm: number | undefined,
): NoteEventsDraft {
  const lines = [
    ...events.warnings.map((w) => `${w.code}: ${w.message}${w.t_s == null ? '' : ` (at ${w.t_s}s)`}`),
    ...warnings.map((w) => `${w.code}: ${w.message}${w.timeS === undefined ? '' : ` (at ${w.timeS}s)`}`),
    ...diagnostics,
  ];
  if (tempoBpm !== undefined) {
    lines.push(`inferred: percussion staff, ${score.meta.time.beats}/${score.meta.time.beatValue}, about ${tempoBpm} bpm`);
  }
  return { score, diagnostics: lines };
}

/**
 * One bar's hits as voices: hands then feet, voice 1 and 3, 2 and 4. Hits at one onset on one side go to that side's
 * voices in the order of how many hits their drum has in the bar (the ostinato first); a third hit on a side at one
 * moment has no voice and is dropped. Returns voices in index order, with no gaps (voice 3 before voice 2 would
 * shift indices, so an unused voice 2 is an empty voice).
 */
function voicesOf(hits: readonly Hit[]): Hit[][] {
  const count = new Map<DrumId, number>();
  for (const hit of hits) count.set(hit.drum, (count.get(hit.drum) ?? 0) + 1);
  const priority = (a: Hit, b: Hit): number => (count.get(b.drum) ?? 0) - (count.get(a.drum) ?? 0) || cmp(a.drum, b.drum);

  // voices[0..3] are voice indices 1..4.
  const voices: Hit[][] = [[], [], [], []];
  const byTick = new Map<number, Hit[]>();
  for (const hit of hits) byTick.set(hit.tick, [...(byTick.get(hit.tick) ?? []), hit]);
  for (const [, atTick] of [...byTick].sort((a, b) => a[0] - b[0])) {
    for (const side of [1, 2] as const) {
      const mine = atTick.filter((h) => drumById(h.drum).voice === side).sort(priority);
      mine.slice(0, VOICES_PER_SIDE).forEach((hit, rank) => {
        voices[side - 1 + 2 * rank]!.push(hit);
      });
    }
  }
  // Keep voices 1 and 2 always (a kit with only hands still has its feet voice, empty), 3 and 4 only when used.
  const used = voices[3]!.length > 0 ? 4 : voices[2]!.length > 0 ? 3 : voices[1]!.length > 0 ? 2 : 1;
  return voices.slice(0, used);
}
