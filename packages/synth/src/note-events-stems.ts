/**
 * Synthetic multi-stem ground truth and its NoteEvents rendering (SIB2-147, ADR-0040 amendment).
 *
 * The audio engine has no multi-stem producer yet (a trained separator is groundwork), so the multi-stem importer is
 * built and scored against stems made from our own scores: {@link scoreToStems} renders every part of a ground-truth
 * `Score` (the `fullBandChart` fixture: lead, piano, bass, drums) as one NoteEvents each, **cut from one imaginary
 * recording**: one tempo and one beat grid, the same `source.sha256` and duration, the same jitter model the melody
 * rows use. {@link scoreStemsImport} then imports them and scores each part against the truth part it came from.
 * Seeded and deterministic; Node-free; synthetic only.
 */

import type { NoteEvents, NoteEventsInstrument, Part, Score } from '@sibei/model';
import { TICKS_PER_QUARTER, barCapacity, chordTones, drumById, durationTicks, mapStemsToScore, pitchToMidi } from '@sibei/model';
import { JITTER_PROFILES, clamp01, gauss, note, round3 } from './note-events.js';
import type { RenderOptions } from './note-events.js';
import { makeRng } from './rng.js';

/** The source hash every synthetic stem of one mix shares. */
export const SYNTHETIC_MIX_SHA256 = 'c0ffee'.repeat(10) + 'c0ff';

/** What a part of a ground-truth score is, as an audio separator would label its stem. */
export function instrumentOfPart(part: Part): NoteEventsInstrument {
  if (part.staves.some((s) => s.type === 'percussion')) return 'drums';
  if (part.staves.length >= 2) return 'piano';
  if (part.instrument === 32 || part.instrument === 33 || /bass/i.test(part.name)) return 'bass';
  return 'voice';
}

interface Struck {
  tick: number;
  ticks: number;
  pitch: number;
  /** The drum a percussion note names; its identity (a drum has no pitch). */
  drum?: string;
}

/** Every struck note of a part (a tie's continuation is not a new note) at its absolute tick. */
function struckNotes(score: Score, part: Part): Struck[] {
  const capacity = barCapacity(score.meta.time);
  const out: Struck[] = [];
  for (const staff of part.staves) {
    for (const bar of staff.bars) {
      const number = score.bars.find((b) => b.id === bar.barId)!.number;
      for (const voice of bar.voices) {
        for (const item of voice.items) {
          if (item.kind !== 'note') continue;
          const tick = (number - 1) * capacity + item.onset;
          if (staff.type === 'percussion') {
            // A hit the truth gives no drum (the fixture's one-line staff) is a closed hi-hat, GM key 42.
            const def = item.drum === undefined ? drumById('hihat') : drumById(item.drum);
            out.push({ tick, ticks: durationTicks(item.duration), pitch: def.gm, drum: def.id });
            continue;
          }
          for (const tone of chordTones(item)) {
            if (tone.tie === 'stop' || tone.tie === 'both') continue;
            out.push({ tick, ticks: durationTicks(item.duration), pitch: pitchToMidi(tone.pitch) });
          }
        }
      }
    }
  }
  return out.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
}

/** One NoteEvents per part of `score`, all from one imaginary recording (one tempo, one beat grid). */
export function scoreToStems(score: Score, options: RenderOptions): NoteEvents[] {
  const profile = JITTER_PROFILES[options.level];
  const rng = makeRng(options.seed * 7919 + 31);
  const bpm = rng.int(80, 140);
  const secondsPerTick = 60 / bpm / TICKS_PER_QUARTER;
  const beatSeconds = 60 / bpm;
  const beatsPerBar = score.meta.time.beats;

  const parts = score.parts.map((part) => ({ instrument: instrumentOfPart(part), struck: struckNotes(score, part) }));
  const endTicks = Math.max(...parts.flatMap((p) => p.struck.map((s) => s.tick + s.ticks)), 0);
  const duration = round3(endTicks * secondsPerTick + 0.5);
  const beatCount = Math.ceil((endTicks * secondsPerTick) / beatSeconds) + 1;

  return parts.map(({ instrument, struck }): NoteEvents => {
    const notes: NoteEvents['notes'] = struck.map((s, id) => {
      const onset = Math.max(0, s.tick * secondsPerTick + profile.lateBias + gauss(rng, profile.onsetSigma));
      const length = s.ticks * secondsPerTick;
      const offset = Math.max(onset + 0.04, s.tick * secondsPerTick + length * 0.92 + gauss(rng, profile.offsetSigma));
      const made = note(`n${id}`, onset, offset, s.pitch, clamp01(0.92 - Math.abs(gauss(rng, profile.onsetSigma * 4))));
      return s.drum === undefined ? made : { ...made, drum_class: s.drum };
    });
    // Each stem's beat tracker is its own estimate of the one grid (a little jitter apiece), as separated stems give.
    const beats: NoteEvents['beats'] = Array.from({ length: beatCount }, (_unused, i) => ({
      t_s: Math.max(0, i * beatSeconds + gauss(rng, profile.onsetSigma / 4)),
      is_downbeat: profile.downbeats ? i % beatsPerBar === 0 : null,
    }));
    return {
      schema_version: 1,
      source: { sha256: SYNTHETIC_MIX_SHA256, duration_s: duration },
      instrument,
      producer: { model_id: 'synth-stems', model_version: options.level, stage: 'transcribe' },
      beats,
      notes,
      warnings: profile.downbeats ? [] : [{ code: 'downbeats_unknown', message: 'the beat tracker does not mark bar lines' }],
    };
  });
}

export interface StemsImportMetrics {
  /** Per part, in the draft's (conventional) order: note F1 against the truth part of the same instrument. */
  parts: Array<{ name: string; noteF1: number; notes: number }>;
  /** The mean of the part F1s. */
  meanNoteF1: number;
}

/** Import the stems and score each draft part against the truth part it came from (pitch, or drum, at an absolute tick). */
export function scoreStemsImport(truth: Score, stems: readonly NoteEvents[]): StemsImportMetrics {
  const { score: draft } = mapStemsToScore(stems, { id: 'eval-stems' });
  const truthParts = truth.parts.map((part) => ({ instrument: instrumentOfPart(part), struck: struckNotes(truth, part) }));
  const parts = draft.parts.map((part) => {
    const instrument = instrumentOfPart(part);
    const want = truthParts.find((t) => t.instrument === instrument)?.struck ?? [];
    const key = (s: Struck): string => `${s.tick}:${s.drum ?? s.pitch}`;
    const expected = new Map<string, number>();
    for (const s of want) expected.set(key(s), (expected.get(key(s)) ?? 0) + 1);
    const found = struckNotes(draft, part);
    let matched = 0;
    for (const s of found) {
      if ((expected.get(key(s)) ?? 0) > 0) {
        matched += 1;
        expected.set(key(s), expected.get(key(s))! - 1);
      }
    }
    const precision = found.length === 0 ? 0 : matched / found.length;
    const recall = want.length === 0 ? 1 : matched / want.length;
    return { name: part.name, notes: want.length, noteF1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall) };
  });
  return { parts, meanNoteF1: parts.length === 0 ? 0 : parts.reduce((a, p) => a + p.noteF1, 0) / parts.length };
}
