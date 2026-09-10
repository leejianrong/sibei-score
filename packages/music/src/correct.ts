import { formatChord } from './format.js';
import { parseChord } from './parse.js';

/**
 * The grammar corrector (ADR-0011). Off-the-shelf OCR on a chord band produces text that is
 * *nearly* a chord — `Cm7bS` for `Cm7b5`, `Dm7` read as `Dm1` — and chord symbols have very
 * few legal neighbours, so snapping the recognised text to the nearest chord the grammar
 * (ADR-0012) accepts fixes a large share of OCR errors for very little work. This is the
 * mechanism V13's import pipeline reuses rather than building a second one.
 *
 * `correctChord` returns the canonical spelling of the nearest legal chord, or `null` when no
 * small correction lands on one — in which case the caller keeps the text verbatim and flags
 * it, exactly as it would for anything else the grammar cannot read.
 *
 * It is *not* a stopgap and it is not import-only: the same snap makes a forgiving validator
 * for what a user or agent types (a typed `cmaj7` becomes `Cmaj7`). It is deliberately
 * conservative — it corrects glyph confusions and casing, never guesses a quality that is not
 * there — because a corrector that invented harmony would be worse than a flag.
 */
export function correctChord(text: string): string | null {
  for (const candidate of candidates(text)) {
    const chord = parseChord(candidate);
    if (chord !== null) return formatChord(chord);
  }
  return null;
}

/**
 * Glyph confusions an OCR engine makes on a chord band, each mapped to what it was most likely
 * meant to be. Only the safe ones: `l`→`1` is common, but `B`→`8` is not listed because `B` is
 * a real root and correcting it would destroy more chords than it saved. `l` carries two
 * readings — the digit `1` and the letter `i` of `dim` — and the search tries both.
 */
const CONFUSIONS: Record<string, readonly string[]> = {
  S: ['5'],
  s: ['5'],
  l: ['1', 'i'],
  I: ['1'],
  '|': ['1'],
  J: ['j'],
  '¹': ['1'],
};

/** Beyond this many ambiguous glyphs the reading is a guess, not a correction — so we stop. */
const MAX_AMBIGUOUS = 6;

/**
 * Candidate spellings to try, nearest first. Whitespace is dropped and the root letter
 * upper-cased unconditionally (those never change meaning), then every confusable glyph is
 * branched over its possible readings. Ordering by edit distance means the least-corrected
 * reading that parses wins, so `Cm7b5` typed correctly is returned untouched before any
 * substitution is considered.
 */
function candidates(text: string): string[] {
  const base = normalise(text);
  const chars = [...base];
  const ambiguous = chars.filter((ch) => CONFUSIONS[ch] !== undefined).length;
  if (ambiguous > MAX_AMBIGUOUS) return [base];

  const options = chars.map((ch) => {
    const alts = CONFUSIONS[ch];
    return alts === undefined ? [ch] : [ch, ...alts];
  });

  const built = product(options);
  // Nearest first: fewest characters changed from the normalised base.
  return dedupe(built).sort((a, b) => distance(base, a) - distance(base, b));
}

/**
 * Always-safe cleanups: no interior spaces, and a capitalised note letter where a note letter
 * belongs — the root, and the bass after a slash. Casing never changes a chord's meaning, so
 * this runs unconditionally rather than as one branch of the search.
 */
function normalise(text: string): string {
  const stripped = text.trim().replace(/\s+/g, '');
  // Root, and any letter directly after a slash bass.
  return stripped.replace(/(^|\/)([a-g])/g, (_all, lead: string, letter: string) => lead + letter.toUpperCase());
}

/** The Cartesian product of per-position options, assembled left to right. */
function product(options: string[][]): string[] {
  let out = [''];
  for (const choices of options) {
    out = out.flatMap((prefix) => choices.map((choice) => prefix + choice));
  }
  return out;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** Positions that differ. The strings are equal length by construction, so this is a Hamming count. */
function distance(a: string, b: string): number {
  let count = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) count += 1;
  return count;
}
