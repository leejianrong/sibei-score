/**
 * OMR-accuracy metrics: how close a recognised `Score` is to the ground-truth `Score`.
 *
 * This is the measurement R6 asks for and the gate ADR-0011 stage 2 (and all of v0.3) depends
 * on — chord accuracy scored from its first commit rather than judged by eye (ADR-0020). The
 * comparison is Score-vs-Score: run the pipeline (image → worker → `mapOmrToScore`) and hand the
 * result here with the truth the corpus generator recorded.
 *
 * Sequences differ in length (a missed or hallucinated note), so accuracy is alignment-based, not
 * positional: LCS gives the order-preserving matches behind precision/recall/F1, and Levenshtein
 * gives a symbol error rate. Both are the standard OMR way to score two unequal sequences.
 *
 * Framework-free, Node-free plain TypeScript.
 */

import type { Score } from '@sibei/model';
import { scoreMetrics } from '@sibei/model';
import { parseChord, formatChord } from '@sibei/music';
import type { ChordToken, ItemToken } from './labels.js';
import { chordSequence, extractLabels, itemSequence } from './labels.js';

export interface SequenceMetrics {
  /** Order-preserving matches (LCS length). */
  matches: number;
  predLen: number;
  truthLen: number;
  /** matches / predLen — how much of the output was real. */
  precision: number;
  /** matches / truthLen — how much of the truth was found. */
  recall: number;
  f1: number;
  /** matches / max(predLen, truthLen) — one scalar for the table. */
  accuracy: number;
  /** Levenshtein distance / truthLen — the symbol error rate. */
  errorRate: number;
}

export interface OmrMetrics {
  note: SequenceMetrics;
  chord: SequenceMetrics;
  /** Fraction of bars that are metrically valid (ADR-0013). Empty bars count as valid. */
  validBarsRatio: number;
}

type Eq<T> = (a: T, b: T) => boolean;

/** Longest common subsequence length under an equality predicate. */
function lcsLength<T>(a: readonly T[], b: readonly T[], eq: Eq<T>): number {
  const rows = a.length;
  const cols = b.length;
  // One rolling row keeps this O(cols) space; the value is all we need, not the alignment.
  let previous = new Array<number>(cols + 1).fill(0);
  for (let i = 1; i <= rows; i += 1) {
    const current = new Array<number>(cols + 1).fill(0);
    for (let j = 1; j <= cols; j += 1) {
      current[j] = eq(a[i - 1] as T, b[j - 1] as T)
        ? (previous[j - 1] as number) + 1
        : Math.max(previous[j] as number, current[j - 1] as number);
    }
    previous = current;
  }
  return previous[cols] as number;
}

/** Levenshtein edit distance under an equality predicate (sub/ins/del each cost 1). */
function levenshtein<T>(a: readonly T[], b: readonly T[], eq: Eq<T>): number {
  const rows = a.length;
  const cols = b.length;
  let previous = Array.from({ length: cols + 1 }, (_unused, j) => j);
  for (let i = 1; i <= rows; i += 1) {
    const current = new Array<number>(cols + 1).fill(0);
    current[0] = i;
    for (let j = 1; j <= cols; j += 1) {
      const cost = eq(a[i - 1] as T, b[j - 1] as T) ? 0 : 1;
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + cost,
      );
    }
    previous = current;
  }
  return previous[cols] as number;
}

/** Precision/recall/F1/accuracy/error-rate for a predicted sequence against a truth sequence. */
export function computeSequenceMetrics<T>(
  predicted: readonly T[],
  truth: readonly T[],
  eq: Eq<T>,
): SequenceMetrics {
  const predLen = predicted.length;
  const truthLen = truth.length;
  const matches = lcsLength(predicted, truth, eq);

  const precision = predLen === 0 ? (truthLen === 0 ? 1 : 0) : matches / predLen;
  const recall = truthLen === 0 ? 1 : matches / truthLen;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const denom = Math.max(predLen, truthLen);
  const accuracy = denom === 0 ? 1 : matches / denom;
  const errorRate = truthLen === 0 ? (predLen === 0 ? 0 : 1) : levenshtein(predicted, truth, eq) / truthLen;

  return { matches, predLen, truthLen, precision, recall, f1, accuracy, errorRate };
}

/** Two item tokens match when kind, pitch and rhythm all agree. */
export function itemsEqual(a: ItemToken, b: ItemToken): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'note' && b.kind === 'note') {
    return (
      a.step === b.step &&
      a.alter === b.alter &&
      a.octave === b.octave &&
      a.value === b.value &&
      a.dots === b.dots
    );
  }
  return a.value === b.value && a.dots === b.dots;
}

/**
 * A chord symbol reduced to its canonical spelling, so `CM7` and `Cmaj7` compare equal (the same
 * grammar the OCR corrector uses, ADR-0011). Unparseable text compares verbatim rather than being
 * dropped — the store keeps it flagged, and so does the metric (ADR-0012).
 */
export function normalizeChord(text: string): string {
  const parsed = parseChord(text);
  if (parsed === null) return text.trim();
  if (parsed.kind === 'no-chord') return 'N.C.';
  return formatChord(parsed);
}

export function chordsEqual(a: ChordToken, b: ChordToken): boolean {
  return normalizeChord(a.text) === normalizeChord(b.text);
}

/** Fraction of bars that are metrically valid; 1 for a score with no bars (vacuously). */
export function validBarsRatio(score: Score): number {
  const bars = scoreMetrics(score);
  if (bars.length === 0) return 1;
  return bars.filter((bar) => bar.valid).length / bars.length;
}

/** Score a recognised chart against ground truth: note accuracy, chord accuracy, valid bars. */
export function scoreOmr(predicted: Score, truth: Score): OmrMetrics {
  const predLabels = extractLabels(predicted);
  const truthLabels = extractLabels(truth);
  return {
    note: computeSequenceMetrics(itemSequence(predLabels), itemSequence(truthLabels), itemsEqual),
    chord: computeSequenceMetrics(chordSequence(predLabels), chordSequence(truthLabels), chordsEqual),
    validBarsRatio: validBarsRatio(predicted),
  };
}
