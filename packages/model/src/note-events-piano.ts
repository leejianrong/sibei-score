/**
 * Map a piano NoteEvents document onto a grand-staff draft (ADR-0040, ADR-0041 slice 6 follow-on, SIB2-144).
 *
 * The melody mapper is one line; a piano is two hands, chords and several lines at once. So this is its own module,
 * sharing the melody mapper's key inference, spelling and duration splitting and the quantizer's beat grid and snap:
 *
 * - **Quantize.** Each note's onset is snapped to the sixteenth (the clip's steady lateness removed first) and its
 *   offset nudged and snapped, as for a melody. Two notes of one pitch on one sixteenth collapse to the more
 *   confident; a pitch struck again while still sounding cuts the first short.
 * - **Hand split** ({@link assignHands}). Which hand plays a note is not in the audio, so this is a guess, and the
 *   guess is the draft's weakest part (the importer says so in a diagnostic and the editor corrects it). The rule is
 *   deterministic and goes onset by onset: the notes struck together are split by pitch into a left part and a right
 *   part (every cut point is tried, so a chord is never torn unless that is cheaper), and each cut is priced by how
 *   far it takes each hand from where that hand has lately been (an exponentially smoothed centre, so a hand is
 *   stable and does not flip note by note), how wide a hand would have to reach (an octave and a third, 16
 *   semitones, is free; beyond it costs heavily), whether it would cross the other hand's still-sounding notes, and a
 *   mild pull toward the split point (middle C by default) that is what decides the first notes of a piece.
 * - **Voices.** A voice holds one item per onset (stacked chords, SIB2-243, are a later change here), so the notes a hand plays at once are
 *   spread over its voices, highest first (voice 1 stems up, voice 2 down...), and a note that starts while another
 *   still sounds takes the next free voice. A chord of three is therefore three voices on that staff; the model has
 *   no stacked chord, which is the named imperfection. A fifth simultaneous note on a staff is dropped, with a warning.
 * - **Barring** is the beat grid's: a pickup when notes precede the first downbeat, bar 1 flagged when the barring is
 *   a guess, notes tied across bar lines, rests filling every gap in every voice used in the bar.
 * - **Review.** Every note under the confidence floor, one a warning points at, or one the quantizer shortened is
 *   flagged (ADR-0019); every warning comes back as a diagnostic, and so does the hand-split caveat.
 *
 * The draft is `meta.layout: 'score'` (systems break by width, ADR-0041 section 5), one part named Piano (General MIDI
 * program 0) with a treble and a bass staff, so engraving draws a brace. No chords symbols, pedalling or dynamics.
 */

import { makeBar, makeNote, makeRest } from './build.js';
import { makeStaffedScore } from './build-staves.js';
import type { VoiceInit } from './build-staves.js';
import { durationTicks } from './duration.js';
import type { NoteEvents } from './note-events.js';
import { NOTE_CONFIDENCE_FLOOR, inferKey, splitTicks } from './note-events-map.js';
import type { NoteEventsDraft, NoteEventsMapOptions } from './note-events-map.js';
import { restPieces } from './note-events-drums.js';
import { GRID_TICKS, beatGrid, onsetBias, snap } from './note-events-quantize.js';
import type { QuantizedItem, QuantizeWarning } from './note-events-quantize.js';
import { spellPitchAt } from './spelling.js';
import type { BarItem, KeySignature, Review, Score } from './score.js';

/** Middle C: the default pivot between the hands. */
export const DEFAULT_SPLIT_POINT = 60;

/** The widest a hand is assumed to reach without penalty: an octave and a third. */
const HAND_REACH = 16;
/** Cost per semitone beyond {@link HAND_REACH}. High, so a wide chord is split rather than stretched. */
const REACH_COST = 4;
/** Cost per semitone of a hand's new notes from that hand's recent centre. */
const CENTRE_COST = 1;
/** Cost per semitone of a note on the wrong side of the split point. */
const SPLIT_COST = 0.5;
/** Cost per semitone a hand would reach past the other hand's still-sounding notes. */
const CROSS_COST = 2;
/** How much of a hand's centre is kept after it plays something new (the rest comes from the new notes' mean). */
const CENTRE_KEEP = 0.65;
/** Where a hand rests before it has played: an octave either side of the split. */
const HAND_OFFSET = 12;
/** Voices per staff the importer fills (a fifth simultaneous note is dropped). */
const MAX_VOICES = 4;

interface PianoNote {
  id: string;
  midi: number;
  confidence: number;
  /** Ticks on the global axis, snapped. */
  start: number;
  end: number;
  t: number;
  unsure: boolean;
  /** 1 = right hand (the treble staff), 2 = left hand (the bass staff). */
  hand: 1 | 2;
  voice: number;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function flag(): Review {
  return { flagged: true, reasons: ['low-confidence'] };
}

export const PIANO_HAND_SPLIT_WARNING =
  'hand-split: which hand plays each note is a guess (a pitch rule around middle C); review both staves and move notes the guess got wrong';

export function mapPianoEventsToScore(events: NoteEvents, options: NoteEventsMapOptions): NoteEventsDraft {
  const split = options.splitPoint ?? DEFAULT_SPLIT_POINT;
  const sorted = [...events.notes].sort((a, b) => a.onset_s - b.onset_s || a.pitch - b.pitch || cmp(a.id, b.id));
  const grid = beatGrid(events, sorted);
  const warnings = [...grid.warnings];
  const { time, capacity, toTicks } = grid;

  const lowTimes = events.warnings
    .filter((w) => w.t_s != null && (w.code === 'low_confidence' || w.code === 'clipping'))
    .map((w) => w.t_s as number);

  // Place every note on the global tick axis.
  const { bias } = onsetBias(sorted.map((n) => toTicks(n.onset_s)));
  const placed: PianoNote[] = [];
  const at = new Map<string, PianoNote>();
  const shortened = new Set<string>();
  for (const n of sorted) {
    const start = snap(toTicks(n.onset_s) - bias);
    const heard = toTicks(n.offset_s) - toTicks(n.onset_s);
    const end = Math.max(snap(toTicks(n.offset_s) + Math.min(GRID_TICKS / 2, 0.08 * heard)), start + GRID_TICKS);
    const unsure = n.confidence < NOTE_CONFIDENCE_FLOOR || lowTimes.some((t) => t >= n.onset_s - 0.05 && t <= n.offset_s + 0.05);
    const same = at.get(`${n.pitch}@${start}`);
    if (same !== undefined) {
      warnings.push({
        code: 'collapsed-onset',
        message: `notes ${same.id} and ${n.id} landed on the same grid point; kept the more confident`,
        timeS: n.onset_s,
        noteId: n.confidence > same.confidence ? n.id : same.id,
      });
      if (n.confidence > same.confidence) Object.assign(same, { id: n.id, confidence: n.confidence, end, t: n.onset_s, unsure });
      continue;
    }
    const made: PianoNote = { id: n.id, midi: n.pitch, confidence: n.confidence, start, end, t: n.onset_s, unsure, hand: 1, voice: 1 };
    at.set(`${n.pitch}@${start}`, made);
    placed.push(made);
  }

  if (placed.length === 0) {
    warnings.push({ code: 'no-notes', message: 'the document has no notes' });
    return finish(emptyScore(options), warnings, events, undefined);
  }

  // A pitch struck again while it still sounds cuts the first short.
  const lastOf = new Map<number, PianoNote>();
  for (const p of placed) {
    const before = lastOf.get(p.midi);
    if (before !== undefined && before.end > p.start) {
      before.end = p.start;
      shortened.add(before.id);
    }
    lastOf.set(p.midi, p);
  }
  alignChordEnds(placed);

  assignHands(placed, split);
  for (const hand of [1, 2] as const) {
    for (const id of assignVoices(placed.filter((p) => p.hand === hand), warnings)) shortened.add(id);
  }
  // A note the voices could not hold is gone (voice 0).
  const kept = placed.filter((p) => p.voice > 0);
  for (const p of kept) if (shortened.has(p.id)) p.unsure = true;

  const key = inferKey(kept.map(asQuantized));

  // Bars from the first note's bar to the last note's; leading silence is trimmed.
  const firstBar = Math.floor(Math.min(...kept.map((p) => p.start)) / capacity);
  const lastBar = Math.floor((Math.max(...kept.map((p) => p.end)) - 1) / capacity);
  const pickup = firstBar === -1;
  const firstStart = Math.min(...kept.map((p) => p.start));
  const spans: Array<{ number: number; start: number; length: number }> = [];
  for (let index = firstBar; index <= lastBar; index += 1) {
    const number = pickup ? index + 1 : index - firstBar + 1;
    if (pickup && index === -1) spans.push({ number, start: firstStart, length: -firstStart });
    else spans.push({ number, start: index * capacity, length: capacity });
  }

  const guessedBarring = warnings.some((w) => w.code === 'no-downbeats' || w.code === 'no-beat-grid');
  const flaggedIds = new Set(kept.filter((p) => p.unsure).map((p) => p.id));
  const views = spans.map((span, index) =>
    makeBar({ id: `bar-${span.number}`, number: span.number, ...(index === 0 && guessedBarring ? { review: flag() } : {}) }),
  );

  const staffBars = (hand: 1 | 2): Array<VoiceInit | VoiceInit[]> => {
    const mine = kept.filter((p) => p.hand === hand);
    return spans.map((span) => {
      const end = span.start + span.length;
      const inBar = mine.filter((p) => p.start < end && p.end > span.start);
      const used = Math.max(1, ...inBar.map((p) => p.voice));
      const voices: VoiceInit[] = [];
      for (let voice = 1; voice <= used; voice += 1) {
        voices.push({ items: voiceItems(inBar.filter((p) => p.voice === voice), span, key, flaggedIds, ids(span.number, hand, voice)) });
      }
      return voices.length === 1 ? voices[0]! : voices;
    });
  };
  const right = staffBars(1);
  const left = staffBars(2);

  const base = makeStaffedScore({
    id: options.id,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.composer === undefined ? {} : { composer: options.composer }),
    key,
    time,
    bars: views,
    parts: [
      {
        name: 'Piano',
        instrument: 0,
        staves: [
          { clef: 'treble', bars: right },
          { clef: 'bass', bars: left },
        ],
      },
    ],
  });
  return finish(withScoreLayout(base), warnings, events, grid.tempoBpm, key);
}

/** An id prefix per (bar, hand, voice): unique across the score without a counter shared between staves. */
function ids(bar: number, hand: number, voice: number): string {
  return `${bar}-${hand}-${voice}`;
}

function voiceItems(
  notes: readonly PianoNote[],
  span: { number: number; start: number; length: number },
  key: KeySignature,
  flagged: ReadonlySet<string>,
  idPart: string,
): BarItem[] {
  const items: BarItem[] = [];
  const spanEnd = span.start + span.length;
  let cursor = 0;
  let notesMade = 0;
  let restsMade = 0;
  const rest = (from: number, ticks: number): void => {
    let at = from;
    for (const duration of restPieces(from, ticks)) {
      restsMade += 1;
      items.push(makeRest({ id: `rest-${idPart}-${restsMade}`, onset: at, duration }));
      at += durationTicks(duration);
    }
  };
  for (const p of [...notes].sort((a, b) => a.start - b.start)) {
    const from = Math.max(p.start, span.start);
    const to = Math.min(p.end, spanEnd);
    const onset = from - span.start;
    if (onset > cursor) rest(cursor, onset - cursor);
    const pieces = splitTicks(onset, to - from);
    let at = onset;
    pieces.forEach((duration, i) => {
      const continues = i < pieces.length - 1 || p.end > spanEnd;
      const follows = i > 0 || p.start < span.start;
      notesMade += 1;
      items.push(
        makeNote({
          id: `note-${idPart}-${notesMade}`,
          onset: at,
          duration,
          pitch: spellPitchAt(p.midi, key),
          tie: continues ? (follows ? 'both' : 'start') : follows ? 'stop' : 'none',
          confidence: p.confidence,
          ...(flagged.has(p.id) ? { review: flag() } : {}),
        }),
      );
      at += durationTicks(duration);
    });
    cursor = to - span.start;
  }
  if (cursor < span.length) rest(cursor, span.length - cursor);
  return items;
}

function asQuantized(p: PianoNote): QuantizedItem {
  return { kind: 'note', onset: 0, ticks: p.end - p.start, midi: p.midi, confidence: p.confidence, sourceId: p.id, tiedFromPrevious: false, tiedToNext: false };
}

function withScoreLayout(score: Score): Score {
  return { ...score, meta: { ...score.meta, layout: 'score' } };
}

function emptyScore(options: NoteEventsMapOptions): Score {
  return withScoreLayout(
    makeStaffedScore({
      id: options.id,
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.composer === undefined ? {} : { composer: options.composer }),
      bars: [makeBar({ id: 'bar-1', number: 1 })],
      parts: [{ name: 'Piano', instrument: 0, staves: [{ clef: 'treble', bars: [] }, { clef: 'bass', bars: [] }] }],
    }),
  );
}

function finish(
  score: Score,
  warnings: ReadonlyArray<{ code: string; message: string; timeS?: number }>,
  events: NoteEvents,
  tempoBpm: number | undefined,
  key?: KeySignature,
): NoteEventsDraft {
  const lines = [
    ...events.warnings.map((w) => `${w.code}: ${w.message}${w.t_s == null ? '' : ` (at ${w.t_s}s)`}`),
    ...warnings.map((w) => `${w.code}: ${w.message}${w.timeS === undefined ? '' : ` (at ${w.timeS}s)`}`),
    PIANO_HAND_SPLIT_WARNING,
  ];
  if (tempoBpm !== undefined && key !== undefined) {
    lines.push(`inferred: ${key.tonic}${key.alter === 1 ? '#' : key.alter === -1 ? 'b' : ''} ${key.mode}, ${score.meta.time.beats}/${score.meta.time.beatValue}, about ${tempoBpm} bpm, grand staff`);
  }
  return { score, diagnostics: lines };
}

/**
 * Notes struck together whose ends differ by a step or less are one chord: they get the earliest end, so a chord whose
 * transcribed offsets wobble is not read as two rhythms in two voices.
 */
function alignChordEnds(notes: PianoNote[]): void {
  const byStart = new Map<number, PianoNote[]>();
  for (const n of notes) byStart.set(n.start, [...(byStart.get(n.start) ?? []), n]);
  for (const group of byStart.values()) {
    const ordered = [...group].sort((a, b) => a.end - b.end);
    let anchor = ordered[0]!.end;
    for (const n of ordered) {
      if (n.end - anchor <= GRID_TICKS) n.end = anchor;
      else anchor = n.end;
    }
  }
}

// ---------------------------------------------------------------------------
// The hand split
// ---------------------------------------------------------------------------

/**
 * Assign every note to the right hand (1) or the left (2), deterministically and in one pass over the onsets.
 */
function assignHands(notes: PianoNote[], split: number = DEFAULT_SPLIT_POINT): void {
  const centre: Record<1 | 2, number> = { 1: split + HAND_OFFSET, 2: split - HAND_OFFSET };
  const held: Record<1 | 2, Array<{ midi: number; end: number }>> = { 1: [], 2: [] };
  const byStart = new Map<number, PianoNote[]>();
  for (const n of notes) byStart.set(n.start, [...(byStart.get(n.start) ?? []), n]);

  for (const [start, group] of [...byStart].sort((a, b) => a[0] - b[0])) {
    held[1] = held[1].filter((h) => h.end > start);
    held[2] = held[2].filter((h) => h.end > start);
    const ordered = [...group].sort((a, b) => a.midi - b.midi || cmp(a.id, b.id));
    let bestK = 0;
    let bestCost = Infinity;
    // The lowest k notes to the left hand, the rest to the right.
    for (let k = 0; k <= ordered.length; k += 1) {
      const left = ordered.slice(0, k).map((n) => n.midi);
      const right = ordered.slice(k).map((n) => n.midi);
      const cost = handCost(left, 2, centre[2], held, split) + handCost(right, 1, centre[1], held, split);
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        bestK = k;
      }
    }
    ordered.forEach((n, i) => {
      n.hand = i < bestK ? 2 : 1;
      held[n.hand].push({ midi: n.midi, end: n.end });
    });
    for (const hand of [1, 2] as const) {
      const mine = ordered.filter((n) => n.hand === hand);
      if (mine.length > 0) {
        const mean = mine.reduce((sum, n) => sum + n.midi, 0) / mine.length;
        centre[hand] = CENTRE_KEEP * centre[hand] + (1 - CENTRE_KEEP) * mean;
      }
    }
  }
}

function handCost(
  fresh: readonly number[],
  hand: 1 | 2,
  centre: number,
  held: Record<1 | 2, Array<{ midi: number; end: number }>>,
  split: number,
): number {
  if (fresh.length === 0) return 0;
  const sounding = [...fresh, ...held[hand].map((h) => h.midi)];
  const span = Math.max(...sounding) - Math.min(...sounding);
  let cost = REACH_COST * Math.max(0, span - HAND_REACH);
  for (const midi of fresh) {
    cost += CENTRE_COST * Math.abs(midi - centre);
    cost += SPLIT_COST * (hand === 1 ? Math.max(0, split - midi) : Math.max(0, midi - split));
  }
  const other = held[hand === 1 ? 2 : 1];
  if (other.length > 0) {
    // The right hand reaching below the left's held notes, or the left above the right's.
    if (hand === 1) cost += CROSS_COST * Math.max(0, Math.max(...other.map((h) => h.midi)) - Math.min(...fresh));
    else cost += CROSS_COST * Math.max(0, Math.max(...fresh) - Math.min(...other.map((h) => h.midi)));
  }
  return cost;
}

// ---------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------

/**
 * Give each note of one hand a voice: the notes struck together highest first onto the lowest free voices, so a chord's
 * top note keeps voice 1. A note that starts while every voice is busy cuts the soonest-ending voice short (named in
 * the returned ids, for the review flag); at the same instant with every voice just taken, the note is dropped
 * (`voice` 0) with a warning. Returns the ids of the notes it shortened.
 */
function assignVoices(hand: PianoNote[], warnings: QuantizeWarning[]): string[] {
  const cut: string[] = [];
  const holding: Array<PianoNote | null> = Array.from({ length: MAX_VOICES }, () => null);
  const ordered = [...hand].sort((a, b) => a.start - b.start || b.midi - a.midi || cmp(a.id, b.id));
  for (const n of ordered) {
    let free = holding.findIndex((h) => h === null || h.end <= n.start);
    if (free < 0) {
      // Every voice is sounding: shorten the one that would end first, unless it began at this very instant.
      let soonest = -1;
      holding.forEach((h, i) => {
        if (h !== null && h.start < n.start && (soonest < 0 || h.end < holding[soonest]!.end)) soonest = i;
      });
      if (soonest < 0) {
        n.voice = 0;
        warnings.push({
          code: 'dropped-note',
          message: `note ${n.id} was a fifth voice at one moment on one hand; dropped`,
          timeS: n.t,
          noteId: n.id,
        });
        continue;
      }
      const victim = holding[soonest]!;
      warnings.push({ code: 'overlap', message: `note ${victim.id} overlaps ${n.id}; shortened`, timeS: n.t, noteId: victim.id });
      victim.end = n.start;
      cut.push(victim.id);
      free = soonest;
    }
    holding[free] = n;
    n.voice = free + 1;
  }
  return cut;
}
