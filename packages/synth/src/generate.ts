/**
 * A seeded generator of plausible lead sheets.
 *
 * This is the "ground-truth data generator run in reverse" that both V12's eval corpus and
 * v0.3's training data rest on (ADR-0020, ADR-0031): produce a `Score`, and — because the
 * score is what we rendered — its notes and chords ARE the labels, for free. Here we build
 * only the `Score`; rendering it to an image and degrading that image is the imaging layer
 * (`@sibei/synth/imaging`), and reading pixel boxes off the layout is V15's extension.
 *
 * Plausible, not random noise: melodies are diatonic to the key and move by small steps, bars
 * sum exactly to the meter (a real lead sheet is metrically valid — it is the *photo* that
 * makes OMR hard, not the rhythm, ADR-0013), and chords are the diatonic seventh chords a jazz
 * reader expects. Everything is drawn from the seeded `Rng`, so a seed reproduces the chart.
 *
 * Framework-free, Node-free plain TypeScript.
 */

import type {
  Alter,
  Bar,
  Chord as ModelChord,
  Duration,
  KeySignature,
  Score,
  Step,
  TimeSignature,
} from '@sibei/model';
import {
  DEFAULT_KEY,
  DEFAULT_TIME,
  barCapacity,
  beatTicks,
  createIdFactory,
  dur,
  durationTicks,
  makeBar,
  makeChord,
  makeNote,
  makeRest,
  makeScore,
  makeSection,
} from '@sibei/model';
import type { ChordStructure, Root } from '@sibei/music';
import { formatChord } from '@sibei/music';
import type { Rng } from './rng.js';
import { makeRng } from './rng.js';

export interface GenerateOptions {
  /** Reproducibility: the same seed yields the same score. Required — there is no implicit seed. */
  seed: number;
  /** Score id (default `synth-<seed>`). */
  id?: string;
  /** Full bars, not counting a pickup (default 8). */
  bars?: number;
  /** Default 4/4. */
  time?: TimeSignature;
  /** Default C major. Melody and chords are diatonic to it, so pitches are always well spelled. */
  key?: KeySignature;
  /** Emit chord symbols above the staff (default true). */
  chords?: boolean;
  /** Emit one section starting at bar 1 (default true) — layout breaks lines at sections (ADR-0015). */
  section?: boolean;
  /** Melody title/composer, for the header. Default empty (a real import has none until OCR, Q37). */
  title?: string;
  composer?: string;
}

const STEPS: readonly Step[] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const STEP_SEMITONE: Record<Step, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** Semitone offsets of the major scale degrees from the tonic. */
const MAJOR_OFFSETS = [0, 2, 4, 5, 7, 9, 11] as const;

/**
 * The seven pitch classes of a major key, each correctly spelled (F# not Gb in D major). Kept to
 * major keys: it is all the generator needs, and it guarantees a legal `Alter` in [-2, 2].
 */
function majorScale(key: KeySignature): Root[] {
  const tonicIndex = STEPS.indexOf(key.tonic);
  const tonicSemitone = STEP_SEMITONE[key.tonic] + key.alter;
  return MAJOR_OFFSETS.map((offset, degree) => {
    const step = STEPS[(tonicIndex + degree) % 7] as Step;
    const target = tonicSemitone + offset;
    const natural = STEP_SEMITONE[step];
    let alter = (((target - natural) % 12) + 12) % 12;
    if (alter > 6) alter -= 12; // choose the nearest spelling, e.g. -1 rather than +11
    return { step, alter: alter as Alter };
  });
}

/** The diatonic seventh chord on a scale degree, the way a jazz reader harmonises a major key. */
function diatonicChord(scale: Root[], degree: number): ChordStructure {
  const root = scale[degree % 7] as Root;
  // I maj7, ii m7, iii m7, IV maj7, V 7, vi m7, vii m7b5.
  const triad: ChordStructure['triad'] =
    degree === 0 || degree === 3 || degree === 4
      ? 'major'
      : degree === 6
        ? 'diminished'
        : 'minor';
  const seventh: ChordStructure['seventh'] =
    degree === 0 || degree === 3 ? 'major' : 'minor';
  const alterations: ChordStructure['alterations'] =
    degree === 6 ? [{ degree: 5, alter: -1 }] : [];
  return {
    root,
    triad,
    seventh,
    extension: null,
    sixth: false,
    power: false,
    suspension: null,
    additions: [],
    alterations,
    alt: false,
    bass: null,
  };
}

/** Note values a melody is built from, weighted toward the middle of the rhythmic range. */
const RHYTHM_MENU: readonly { duration: Duration; weight: number }[] = [
  { duration: dur(4), weight: 6 }, // quarter
  { duration: dur(8), weight: 4 }, // eighth
  { duration: dur(2), weight: 2 }, // half
  { duration: dur(4, 1), weight: 2 }, // dotted quarter
  { duration: dur(2, 1), weight: 1 }, // dotted half
];

/** A rhythm that fills the bar exactly, greedily fitting durations that still fit the remainder. */
function fillBar(rng: Rng, capacity: number): Duration[] {
  const durations: Duration[] = [];
  let remaining = capacity;
  while (remaining > 0) {
    const affordable = RHYTHM_MENU.filter((entry) => durationTicks(entry.duration) <= remaining);
    if (affordable.length === 0) {
      // No menu value fits (a fraction left by a dotted value); close the bar with the largest
      // plain value that divides the remainder. eighth = 240 divides every tick this menu leaves.
      durations.push(dur(remaining >= 480 ? 4 : 8));
      remaining -= remaining >= 480 ? 480 : 240;
      continue;
    }
    const choice = rng.weighted(
      affordable.map((entry) => entry.duration),
      affordable.map((entry) => entry.weight),
    );
    durations.push(choice);
    remaining -= durationTicks(choice);
  }
  return durations;
}

/**
 * Generate a lead sheet. Deterministic in `seed`; every other option only shapes the result.
 */
export function generateScore(options: GenerateOptions): Score {
  const seed = options.seed;
  const rng = makeRng(seed);
  const barCount = options.bars ?? 8;
  const time = options.time ?? DEFAULT_TIME;
  const key = options.key ?? DEFAULT_KEY;
  const withChords = options.chords ?? true;
  const withSection = options.section ?? true;
  const scale = majorScale(key);
  const ids = createIdFactory();
  const capacity = barCapacity(time);
  const beat = beatTicks(time);

  // A diatonic "ladder": integer position, degree = pos mod 7, octave rises every 7 steps. The
  // melody walks it by small intervals so it sounds like a line, not a random-note generator.
  const LADDER_MIN = 0; // tonic in octave 4
  const LADDER_MAX = 14; // tonic two octaves up
  let position = rng.int(3, 9);

  const ladderToPitch = (pos: number): { step: Step; alter: Alter; octave: number } => {
    const degree = ((pos % 7) + 7) % 7;
    const octave = 4 + Math.floor(pos / 7);
    const root = scale[degree] as Root;
    return { step: root.step, alter: root.alter, octave };
  };

  const bars: Bar[] = [];
  for (let barNumber = 1; barNumber <= barCount; barNumber += 1) {
    const rhythm = fillBar(rng, capacity);
    const items = [];
    let cursor = 0;
    for (const duration of rhythm) {
      // A rest now and then, but never the whole bar and never the downbeat of bar 1.
      const rest = rng.bool(0.15) && !(barNumber === 1 && cursor === 0);
      if (rest) {
        items.push(makeRest({ id: ids.next('rest'), onset: cursor, duration }));
      } else {
        // Move by a small diatonic interval, biased to steps, clamped to the ladder range.
        const step = rng.weighted([-2, -1, 0, 1, 2, 3], [2, 5, 1, 5, 2, 1]);
        position = Math.max(LADDER_MIN, Math.min(LADDER_MAX, position + step));
        items.push(
          makeNote({ id: ids.next('note'), onset: cursor, duration, pitch: ladderToPitch(position) }),
        );
      }
      cursor += durationTicks(duration);
    }

    const chords: ModelChord[] = [];
    if (withChords) {
      chords.push(
        makeChord({
          id: ids.next('chord'),
          onset: 0,
          text: formatChord({ kind: 'chord', structure: diatonicChord(scale, rng.int(0, 6)) }),
        }),
      );
      // A second chord on beat 3 some of the time, so bars are not uniformly one-chord.
      if (time.beats >= 4 && rng.bool(0.35)) {
        chords.push(
          makeChord({
            id: ids.next('chord'),
            onset: 2 * beat,
            text: formatChord({ kind: 'chord', structure: diatonicChord(scale, rng.int(0, 6)) }),
          }),
        );
      }
    }

    bars.push(makeBar({ id: ids.next('bar'), number: barNumber, items, chords }));
  }

  const sections = withSection
    ? [makeSection({ id: ids.next('section'), startBar: 1, letter: 'A' })]
    : [];

  return makeScore({
    id: options.id ?? `synth-${seed}`,
    title: options.title ?? '',
    composer: options.composer ?? '',
    key,
    time,
    bars,
    sections,
  });
}
