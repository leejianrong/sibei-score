/**
 * Ground-truth score to NoteEvents with realistic timing jitter (ADR-0040, SIB2-134).
 *
 * The audio-import evaluation needs no audio: render a known `Score` the way a transcriber would
 * report it — seconds, a steady tempo, onsets and offsets that wobble — run the importer over it, and
 * score the draft against the score we started from. This is the quantizer's number (it decides sheet
 * quality more than the audio F1 does), and the corpus is shareable with the audio repo's eval because
 * its ground truth is a score in this repo's model.
 *
 * Seeded and deterministic (a `(seed, level)` pair always yields the same document), like every other
 * corpus here (ADR-0020). Pure; Node-free.
 */

import type { NoteEvents, Score } from '@sibei/model';
import { TICKS_PER_QUARTER, barCapacity, durationTicks, mapNoteEventsToScore, pitchToMidi } from '@sibei/model';
import { extractLabels, itemSequence } from './labels.js';
import { itemsEqual, scoreOmr } from './metrics.js';
import type { OmrMetrics } from './metrics.js';
import type { Rng } from './rng.js';
import { makeRng } from './rng.js';

/** A named, reproducible amount of timing damage. */
export type JitterLevel = 'clean' | 'light' | 'medium' | 'heavy' | 'unmarked';

export interface JitterProfile {
  /** Standard deviation of onset error, seconds. */
  onsetSigma: number;
  /** Standard deviation of offset error, seconds. */
  offsetSigma: number;
  /** Seconds every onset is late by on average (soft attacks). */
  lateBias: number;
  /** Fraction of notes the transcriber splits in two. */
  splitRate: number;
  /** Fraction of notes it misses. */
  dropRate: number;
  /** Whether the beat tracker marks downbeats. Real output today does not (`downbeats_unknown`). */
  downbeats: boolean;
}

export const JITTER_PROFILES: Record<JitterLevel, JitterProfile> = {
  clean: { onsetSigma: 0, offsetSigma: 0, lateBias: 0, splitRate: 0, dropRate: 0, downbeats: true },
  light: { onsetSigma: 0.012, offsetSigma: 0.02, lateBias: 0, splitRate: 0, dropRate: 0, downbeats: true },
  medium: { onsetSigma: 0.03, offsetSigma: 0.04, lateBias: 0.02, splitRate: 0, dropRate: 0, downbeats: true },
  heavy: { onsetSigma: 0.05, offsetSigma: 0.06, lateBias: 0.03, splitRate: 0.04, dropRate: 0.02, downbeats: true },
  /** Medium jitter and no downbeat flags: where bar 1 starts is the importer's guess. */
  unmarked: { onsetSigma: 0.03, offsetSigma: 0.04, lateBias: 0.02, splitRate: 0, dropRate: 0, downbeats: false },
};

export const JITTER_LEVELS = Object.keys(JITTER_PROFILES) as JitterLevel[];

export interface RenderOptions {
  seed: number;
  level: JitterLevel;
  instrument?: 'voice' | 'bass';
}

/** Render a ground-truth score as the NoteEvents a transcriber might report for a performance of it. */
export function scoreToNoteEvents(score: Score, options: RenderOptions): NoteEvents {
  const profile = JITTER_PROFILES[options.level];
  const rng = makeRng(options.seed * 7919 + 31);
  const bpm = rng.int(80, 140);
  const secondsPerTick = 60 / bpm / TICKS_PER_QUARTER;
  const capacity = barCapacity(score.meta.time);
  const beatSeconds = 60 / bpm;

  const notes: NoteEvents['notes'] = [];
  let id = 0;
  let endTicks = 0;
  for (const bar of score.bars) {
    const barStart = (bar.number - 1) * capacity;
    for (const item of bar.items) {
      const start = barStart + item.onset;
      endTicks = Math.max(endTicks, start + durationTicks(item.duration));
      if (item.kind !== 'note') continue;
      if (profile.dropRate > 0 && rng.bool(profile.dropRate)) continue;
      const length = durationTicks(item.duration) * secondsPerTick;
      const onset = Math.max(0, start * secondsPerTick + profile.lateBias + gauss(rng, profile.onsetSigma));
      // Played slightly short, as a sung or plucked note is, plus offset error.
      const offset = Math.max(onset + 0.04, start * secondsPerTick + length * 0.92 + gauss(rng, profile.offsetSigma));
      const confidence = clamp01(0.92 - Math.abs(gauss(rng, profile.onsetSigma * 4)));
      const pitch = pitchToMidi(item.pitch);
      if (profile.splitRate > 0 && length > 0.25 && rng.bool(profile.splitRate)) {
        const cut = onset + (offset - onset) * rng.float(0.35, 0.65);
        notes.push(note(`n${id++}`, onset, cut - 0.01, pitch, confidence * 0.7));
        notes.push(note(`n${id++}`, cut + 0.01, offset, pitch, confidence * 0.7));
      } else {
        notes.push(note(`n${id++}`, onset, offset, pitch, confidence));
      }
    }
  }

  const beatCount = Math.ceil((endTicks * secondsPerTick) / beatSeconds) + 1;
  const beatsPerBar = score.meta.time.beats;
  const beats: NoteEvents['beats'] = Array.from({ length: beatCount }, (_unused, i) => ({
    t_s: Math.max(0, i * beatSeconds + gauss(rng, profile.onsetSigma / 4)),
    is_downbeat: profile.downbeats ? i % beatsPerBar === 0 : null,
  }));

  return {
    schema_version: 1,
    source: { sha256: '0'.repeat(64), duration_s: round3(endTicks * secondsPerTick + 0.5) },
    instrument: options.instrument ?? 'voice',
    producer: { model_id: 'synth-jitter', model_version: options.level, stage: 'transcribe' },
    beats,
    notes,
    warnings: profile.downbeats ? [] : [{ code: 'downbeats_unknown', message: 'the beat tracker does not mark bar lines' }],
  };
}

function note(id: string, on: number, off: number, pitch: number, confidence: number): NoteEvents['notes'][number] {
  return { id, onset_s: round3(on), offset_s: round3(Math.max(off, on + 0.001)), pitch, confidence: round3(confidence) };
}

/** A normal deviate by Box-Muller, clamped to 2.5 sigma so one draw cannot wreck a bar. */
function gauss(rng: Rng, sigma: number): number {
  if (sigma === 0) return 0;
  const u = Math.max(rng.next(), 1e-9);
  const v = rng.next();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(-2.5, Math.min(2.5, z)) * sigma;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const round3 = (x: number): number => Math.round(x * 1000) / 1000;

export interface NoteEventsImportMetrics extends OmrMetrics {
  /** Fraction of the truth's bars the draft reproduces exactly, bar for bar by number. */
  barAccuracy: number;
}

/** Import a rendered NoteEvents document and score the draft against the score it was rendered from. */
export function scoreNoteEventsImport(truth: Score, events: NoteEvents): NoteEventsImportMetrics {
  const { score: draft } = mapNoteEventsToScore(events, { id: 'eval-note-events' });
  const base = scoreOmr(draft, truth);
  const draftBars = new Map(draft.bars.map((bar) => [bar.number, itemSequence(extractLabels({ ...draft, bars: [bar] }))]));
  let exact = 0;
  for (const bar of truth.bars) {
    const want = itemSequence(extractLabels({ ...truth, bars: [bar] }));
    const got = draftBars.get(bar.number);
    if (got !== undefined && got.length === want.length && got.every((token, i) => itemsEqual(token, want[i]!))) exact += 1;
  }
  return { ...base, barAccuracy: truth.bars.length === 0 ? 1 : exact / truth.bars.length };
}
