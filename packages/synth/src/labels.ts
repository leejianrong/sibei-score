/**
 * Ground-truth labels for a `Score`: the ordered, comparable form of what is on the page.
 *
 * Because the corpus generator renders a `Score` we already hold, the score *is* the ground
 * truth — but scoring an OMR result needs a canonical, position-independent token sequence to
 * align against (`metrics.ts`), not the whole document. This module is that single tokenizer,
 * used by the metrics on both the predicted and the truth side so the comparison is apples to
 * apples. V15 extends the same extraction with pixel bounding boxes (read off the layout) for
 * training the detector — hence "labels", not just "tokens".
 *
 * Framework-free, Node-free plain TypeScript.
 */

import type { Score, Step, Alter } from '@sibei/model';

/** A melodic note reduced to what OMR can be scored on: pitch and rhythm. */
export interface NoteToken {
  kind: 'note';
  step: Step;
  alter: Alter;
  octave: number;
  /** Note value denominator (4 = quarter). */
  value: number;
  dots: number;
}

export interface RestToken {
  kind: 'rest';
  value: number;
  dots: number;
}

export type ItemToken = NoteToken | RestToken;

export interface ChordToken {
  /** Verbatim symbol text — compared after normalisation through the grammar (`metrics.ts`). */
  text: string;
  /** Ticks from the start of its bar, so two chords in a bar keep their order and beat. */
  onset: number;
}

export interface BarLabel {
  number: number;
  items: ItemToken[];
  chords: ChordToken[];
}

export interface ScoreLabels {
  bars: BarLabel[];
}

/** Extract the comparable label sequence from a score, in reading order. */
export function extractLabels(score: Score): ScoreLabels {
  return {
    bars: score.bars.map((bar) => ({
      number: bar.number,
      items: bar.items.map((item): ItemToken =>
        item.kind === 'note'
          ? {
              kind: 'note',
              step: item.pitch.step,
              alter: item.pitch.alter,
              octave: item.pitch.octave,
              value: item.duration.value,
              dots: item.duration.dots,
            }
          : { kind: 'rest', value: item.duration.value, dots: item.duration.dots },
      ),
      // Onset order keeps two-chords-in-a-bar stable; bar.chords is already stored in order.
      chords: [...bar.chords]
        .sort((a, b) => a.onset - b.onset)
        .map((chord) => ({ text: chord.text, onset: chord.onset })),
    })),
  };
}

/** Every item token across the score, bars in order — the sequence note accuracy aligns on. */
export function itemSequence(labels: ScoreLabels): ItemToken[] {
  return labels.bars.flatMap((bar) => bar.items);
}

/** Every chord token across the score, bars then onset in order — the chord accuracy sequence. */
export function chordSequence(labels: ScoreLabels): ChordToken[] {
  return labels.bars.flatMap((bar) => bar.chords);
}
