/**
 * The flat-semantic CTC vocabulary for the Stage-2a staff recogniser (V15a, ADR-0031).
 *
 * "Flat semantic" means one symbol per whole note-event: a `(pitch, duration)` note or a
 * `(duration)` rest is a single class, so decoding the model's output is one lookup and there is
 * nothing to reassemble (the encoding the monophonic-OMR literature already validated, chosen for
 * the probe so a failure is a data-strategy failure, not a tokeniser one — see the V15 SLICES note
 * and the CTC-vocabulary scoping). The trade is a larger, thinner-tailed alphabet than a factored
 * scheme; if the tail bites, factoring is a contained follow-up.
 *
 * The vocabulary is **closed and complete by construction**: it is derived from the very ladder and
 * duration menu the generator draws from (`generate.ts`), so every token a generated corpus can
 * produce has a class here, and training and eval read one shared manifest with no drift. Index 0 is
 * the CTC blank (PyTorch `nn.CTCLoss` blank=0), real symbols follow in a stable sorted order.
 *
 * Framework-free, Node-free plain TypeScript.
 */

import type { Alter, Duration, KeySignature, Step } from '@sibei/model';
import { DEFAULT_KEY, dur } from '@sibei/model';
import { LADDER_MAX, LADDER_MIN, ladderPitch, majorScale } from './generate.js';
import type { ItemToken, NoteToken, RestToken } from './labels.js';

/**
 * The note values the generator can emit: `RHYTHM_MENU` (quarter, eighth, half, dotted quarter,
 * dotted half) plus `fillBar`'s closers, which are already quarters and eighths. No whole notes,
 * sixteenths or triplets, because the generator emits none — keeping the alphabet tight is the point.
 */
export const VOCAB_DURATIONS: readonly Duration[] = [
  dur(2),
  dur(2, 1),
  dur(4),
  dur(4, 1),
  dur(8),
];

/** The CTC blank symbol, always id 0 (matches PyTorch `nn.CTCLoss(blank=0)`). */
export const BLANK_SYMBOL = '<blank>';

/** e.g. 0 -> "", 1 -> "#", 2 -> "##", -1 -> "b", -2 -> "bb". */
function accidentalMark(alter: Alter): string {
  if (alter > 0) return '#'.repeat(alter);
  if (alter < 0) return 'b'.repeat(-alter);
  return '';
}

/** e.g. quarter -> "4", dotted quarter -> "4d", dotted half -> "2d". */
function durationMark(value: number, dots: number): string {
  return `${value}${'d'.repeat(dots)}`;
}

/** e.g. C4 quarter -> "note_C4_4", F#5 dotted quarter -> "note_F#5_4d". */
export function noteSymbol(step: Step, alter: Alter, octave: number, value: number, dots: number): string {
  return `note_${step}${accidentalMark(alter)}${octave}_${durationMark(value, dots)}`;
}

/** e.g. half rest -> "rest_2". */
export function restSymbol(value: number, dots: number): string {
  return `rest_${durationMark(value, dots)}`;
}

/** The flat-semantic symbol for one label token. */
export function tokenSymbol(token: ItemToken): string {
  return token.kind === 'note'
    ? noteSymbol(token.step, token.alter, token.octave, token.value, token.dots)
    : restSymbol(token.value, token.dots);
}

export interface Vocabulary {
  /** `symbols[id]` — the id is the integer class; `symbols[0]` is the CTC blank. */
  readonly symbols: readonly string[];
  /** Total class count including the blank. */
  readonly size: number;
  /** The keys this vocabulary covers, so a caller can see (and widen) its scope. */
  readonly keys: readonly KeySignature[];
  /** The class id of a token. Throws if the token is outside the vocabulary (a corpus/vocab drift bug). */
  idOf(token: ItemToken): number;
  /** The class id of a symbol string, or undefined if unknown. */
  idOfSymbol(symbol: string): number | undefined;
}

export interface BuildVocabularyOptions {
  /**
   * Keys whose diatonic ladder pitches the vocabulary must cover. Defaults to C major, the key the
   * eval corpus generates today; widen it here when the corpus generates in other keys.
   */
  keys?: readonly KeySignature[];
}

/**
 * Build the closed flat-semantic vocabulary. For every covered key it enumerates the generator's
 * ladder positions (`LADDER_MIN..LADDER_MAX`) crossed with `VOCAB_DURATIONS` as notes, plus one rest
 * per duration. Symbols are de-duplicated (keys share natural pitches), sorted for a stable manifest,
 * and prefixed with the blank at id 0.
 */
export function buildVocabulary(options: BuildVocabularyOptions = {}): Vocabulary {
  const keys = options.keys ?? [DEFAULT_KEY];
  const set = new Set<string>();

  for (const key of keys) {
    const scale = majorScale(key);
    for (let pos = LADDER_MIN; pos <= LADDER_MAX; pos += 1) {
      const pitch = ladderPitch(scale, pos);
      for (const d of VOCAB_DURATIONS) {
        set.add(noteSymbol(pitch.step, pitch.alter, pitch.octave, d.value, d.dots));
      }
    }
  }
  for (const d of VOCAB_DURATIONS) set.add(restSymbol(d.value, d.dots));

  // A plain code-unit sort — deterministic across machines, which is all the manifest needs.
  const symbols = [BLANK_SYMBOL, ...[...set].sort()];
  const idBySymbol = new Map(symbols.map((symbol, id) => [symbol, id] as const));

  return {
    symbols,
    size: symbols.length,
    keys,
    idOfSymbol: (symbol) => idBySymbol.get(symbol),
    idOf(token) {
      const symbol = tokenSymbol(token);
      const id = idBySymbol.get(symbol);
      if (id === undefined) {
        throw new Error(`token not in vocabulary: ${symbol} (widen buildVocabulary keys?)`);
      }
      return id;
    },
  };
}

export type { ItemToken, NoteToken, RestToken };
