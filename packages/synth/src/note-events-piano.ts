/**
 * Synthetic piano ground truth and its NoteEvents rendering (ADR-0040, SIB2-144).
 *
 * The piano importer's two jobs are reading the notes and guessing the hands, so its evaluation scores both: note F1
 * (pitch at an absolute tick) and **hand accuracy** (of the notes found, the share on the staff the truth put them
 * on). The ground truth is a grand-staff `Score` (the staff is the hand, the voices are chord tones and inner lines),
 * so it can come from a fixture or from {@link generatePianoScore}; both are rendered by {@link pianoScoreToNoteEvents}
 * with the same jitter the melody rows use. Seeded and deterministic; Node-free; synthetic only.
 */

import type { NoteEvents, Score } from '@sibei/model';
import {
  TICKS_PER_QUARTER,
  allStaves,
  barCapacity,
  durationTicks,
  makeBar,
  makeNote,
  makeStaffedScore,
  mapNoteEventsToScore,
  pitchToMidi,
  spellPitchAt,
} from '@sibei/model';
import type { BarItem, KeySignature, Note } from '@sibei/model';
import { JITTER_PROFILES, clamp01, gauss, note, round3 } from './note-events.js';
import type { RenderOptions } from './note-events.js';
import { makeRng } from './rng.js';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const TONICS: Array<{ key: KeySignature; pc: number }> = [
  { key: { tonic: 'C', alter: 0, mode: 'major' }, pc: 0 },
  { key: { tonic: 'G', alter: 0, mode: 'major' }, pc: 7 },
  { key: { tonic: 'F', alter: 0, mode: 'major' }, pc: 5 },
  { key: { tonic: 'D', alter: 0, mode: 'major' }, pc: 2 },
];

interface Sound {
  hand: 1 | 2;
  voice: number;
  /** Ticks into the bar. */
  at: number;
  ticks: number;
  midi: number;
}

export interface PianoOptions {
  seed: number;
  bars?: number;
}

/** A plausible piano passage: melody, chords and inner lines on the right, bass, stride, walking or arpeggios on the left. */
export function generatePianoScore(options: PianoOptions): Score {
  const rng = makeRng(options.seed * 104729 + 17);
  const count = options.bars ?? 8;
  const { key, pc } = TONICS[options.seed % TONICS.length]!;
  const scale = (low: number, high: number): number[] => {
    const out: number[] = [];
    for (let m = low; m <= high; m += 1) if (MAJOR.includes((((m - pc) % 12) + 12) % 12)) out.push(m);
    return out;
  };
  const triadOn = (pool: number[], i: number): number[] => [pool[i], pool[i + 2], pool[i + 4]].filter((m): m is number => m !== undefined);
  const walk = (pool: number[], from: number, step: number): number => Math.max(0, Math.min(pool.length - 1, from + step));

  const sounds: Sound[][] = [];
  for (let bar = 0; bar < count; bar += 1) {
    const out: Sound[] = [];
    // Now and then the hands drift toward each other: some right-hand notes below middle C, some left-hand ones above.
    const drift = rng.bool(0.25);
    const rh = scale(drift ? 57 : 62, drift ? 79 : 84);
    const lh = scale(drift ? 43 : 36, drift ? 67 : 58);
    const rhStyle = rng.pick(['melody', 'chords', 'inner'] as const);
    const lhStyle = rng.pick(['stride', 'walking', 'arpeggio', 'whole'] as const);

    if (rhStyle === 'melody') {
      let i = rng.int(2, rh.length - 3);
      for (let step = 0; step < 8; step += 1) {
        out.push({ hand: 1, voice: 1, at: step * 240, ticks: 240, midi: rh[i]! });
        i = walk(rh, i, rng.int(-2, 2));
      }
    } else if (rhStyle === 'chords') {
      let i = rng.int(0, rh.length - 6);
      for (const [beat, ticks] of [[0, 960], [2, 480], [3, 480]] as const) {
        triadOn(rh, i)
          .reverse()
          .forEach((midi, v) => out.push({ hand: 1, voice: v + 1, at: beat * 480, ticks, midi }));
        i = Math.max(0, Math.min(rh.length - 6, i + rng.int(-2, 2)));
      }
    } else {
      let i = rng.int(4, rh.length - 4);
      for (let beat = 0; beat < 4; beat += 1) {
        out.push({ hand: 1, voice: 1, at: beat * 480, ticks: 480, midi: rh[i]! });
        i = walk(rh, i, rng.int(-1, 2));
      }
      out.push({ hand: 1, voice: 2, at: 0, ticks: 960, midi: rh[Math.max(0, i - 4)]! });
      out.push({ hand: 1, voice: 2, at: 960, ticks: 960, midi: rh[Math.max(0, i - 3)]! });
    }

    let j = rng.int(0, Math.max(0, lh.length - 8));
    if (lhStyle === 'stride') {
      for (const beat of [0, 1, 2, 3]) {
        if (beat % 2 === 0) out.push({ hand: 2, voice: 3, at: beat * 480, ticks: 480, midi: lh[j]! });
        else
          triadOn(lh, j + 3)
            .reverse()
            .forEach((midi, v) => out.push({ hand: 2, voice: v + 1, at: beat * 480, ticks: 480, midi }));
      }
    } else if (lhStyle === 'walking') {
      for (let beat = 0; beat < 4; beat += 1) {
        out.push({ hand: 2, voice: 1, at: beat * 480, ticks: 480, midi: lh[j]! });
        j = walk(lh, j, rng.int(-2, 2));
      }
    } else if (lhStyle === 'arpeggio') {
      const tones = triadOn(lh, j);
      for (let step = 0; step < 8; step += 1) {
        const m = [tones[0]!, tones[1]!, tones[2]!, tones[1]!][step % 4]!;
        out.push({ hand: 2, voice: 1, at: step * 240, ticks: 240, midi: m });
      }
    } else {
      triadOn(lh, j)
        .reverse()
        .forEach((midi, v) => out.push({ hand: 2, voice: v + 1, at: 0, ticks: 1920, midi }));
    }
    sounds.push(out);
  }
  return buildScore(options.seed, key, sounds);
}

function buildScore(seed: number, key: KeySignature, sounds: Sound[][]): Score {
  const views = sounds.map((_unused, index) => makeBar({ id: `bar-${index + 1}`, number: index + 1 }));
  const staff = (hand: 1 | 2): Array<Array<{ items: BarItem[] }>> =>
    sounds.map((bar, index) => {
      const mine = bar.filter((s) => s.hand === hand);
      const voices = [...new Set(mine.map((s) => s.voice))].sort((a, b) => a - b);
      return (voices.length === 0 ? [1] : voices).map((voice, vi) => ({
        items: mine
          .filter((s) => s.voice === voice)
          .sort((a, b) => a.at - b.at)
          .map(
            (s, n): BarItem =>
              makeNote({ id: `n-${index + 1}-${hand}-${vi + 1}-${n}`, onset: s.at, duration: durationOf(s.ticks), pitch: spellPitchAt(s.midi, key) }),
          ),
      }));
    });
  return makeStaffedScore({
    id: `synth-piano-${seed}`,
    key,
    bars: views,
    parts: [{ name: 'Piano', instrument: 0, staves: [{ clef: 'treble', bars: staff(1) }, { clef: 'bass', bars: staff(2) }] }],
  });
}

function durationOf(ticks: number): { value: 1 | 2 | 4 | 8 | 16; dots: 0 } {
  return { value: ((TICKS_PER_QUARTER * 4) / ticks) as 1 | 2 | 4 | 8 | 16, dots: 0 };
}

/** Render a grand-staff score as the NoteEvents a transcriber might report for a performance of it (every staff and voice). */
export function pianoScoreToNoteEvents(score: Score, options: RenderOptions): NoteEvents {
  const profile = JITTER_PROFILES[options.level];
  const rng = makeRng(options.seed * 7919 + 31);
  const bpm = rng.int(80, 140);
  const secondsPerTick = 60 / bpm / TICKS_PER_QUARTER;
  const beatSeconds = 60 / bpm;

  const notes: NoteEvents['notes'] = [];
  let id = 0;
  let endTicks = 0;
  for (const { note: n, tick } of truthNotes(score)) {
    const length = durationTicks(n.duration) * secondsPerTick;
    endTicks = Math.max(endTicks, tick + durationTicks(n.duration));
    if (profile.dropRate > 0 && rng.bool(profile.dropRate)) continue;
    const onset = Math.max(0, tick * secondsPerTick + profile.lateBias + gauss(rng, profile.onsetSigma));
    const offset = Math.max(onset + 0.04, tick * secondsPerTick + length * 0.92 + gauss(rng, profile.offsetSigma));
    const confidence = clamp01(0.92 - Math.abs(gauss(rng, profile.onsetSigma * 4)));
    notes.push(note(`n${id++}`, onset, offset, pitchToMidi(n.pitch), confidence));
  }
  notes.sort((a, b) => a.onset_s - b.onset_s || a.pitch - b.pitch);
  const beatCount = Math.ceil((endTicks * secondsPerTick) / beatSeconds) + 1;
  const beatsPerBar = score.meta.time.beats;
  const beats: NoteEvents['beats'] = Array.from({ length: beatCount }, (_unused, i) => ({
    t_s: Math.max(0, i * beatSeconds + gauss(rng, profile.onsetSigma / 4)),
    is_downbeat: profile.downbeats ? i % beatsPerBar === 0 : null,
  }));
  return {
    schema_version: 1,
    source: { sha256: '0'.repeat(64), duration_s: round3(endTicks * secondsPerTick + 0.5) },
    instrument: 'piano',
    producer: { model_id: 'synth-jitter', model_version: options.level, stage: 'transcribe' },
    beats,
    notes,
    warnings: profile.downbeats ? [] : [{ code: 'downbeats_unknown', message: 'the beat tracker does not mark bar lines' }],
  };
}

interface TruthNote {
  note: Note;
  /** Absolute ticks (bar 1 beat 1 is 0). */
  tick: number;
  /** 1 = the treble staff (right hand), 2 = the bass staff. */
  hand: 1 | 2;
}

/** Every struck note (a tie's continuation is not a new note) with its absolute tick and staff, in a stable order. */
function truthNotes(score: Score): TruthNote[] {
  const capacity = barCapacity(score.meta.time);
  const out: TruthNote[] = [];
  allStaves(score).forEach((staff, staffIndex) => {
    for (const bar of staff.bars) {
      const number = score.bars.find((b) => b.id === bar.barId)!.number;
      for (const voice of bar.voices) {
        for (const item of voice.items) {
          if (item.kind !== 'note' || item.tie === 'stop' || item.tie === 'both') continue;
          out.push({ note: item, tick: (number - 1) * capacity + item.onset, hand: staffIndex === 0 ? 1 : 2 });
        }
      }
    }
  });
  return out;
}

export interface PianoImportMetrics {
  noteF1: number;
  /** Of the notes the draft found and the truth has (same pitch, same tick), the share on the right staff. */
  handAccuracy: number;
  notes: number;
}

/** Import a rendered piano NoteEvents document and score the draft against the grand-staff score it came from. */
export function scorePianoImport(truth: Score, events: NoteEvents): PianoImportMetrics {
  const { score: draft } = mapNoteEventsToScore(events, { id: 'eval-piano' });
  const expected = truthNotes(truth);
  const want = new Map<string, number[]>();
  for (const t of expected) {
    const key = `${t.tick}:${pitchToMidi(t.note.pitch)}`;
    want.set(key, [...(want.get(key) ?? []), t.hand]);
  }
  let matched = 0;
  let right = 0;
  let got = 0;
  for (const d of truthNotes(draft)) {
    got += 1;
    const hands = want.get(`${d.tick}:${pitchToMidi(d.note.pitch)}`);
    if (hands === undefined || hands.length === 0) continue;
    matched += 1;
    const at = hands.indexOf(d.hand);
    if (at >= 0) {
      right += 1;
      hands.splice(at, 1);
    } else hands.shift();
  }
  const precision = got === 0 ? 0 : matched / got;
  const recall = expected.length === 0 ? 1 : matched / expected.length;
  return {
    noteF1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    handAccuracy: matched === 0 ? 0 : right / matched,
    notes: expected.length,
  };
}
