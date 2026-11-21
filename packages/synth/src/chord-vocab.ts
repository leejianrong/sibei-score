/**
 * The character-level CTC vocabulary for the Stage-2b chord-band recogniser (V17b, ADR-0031).
 *
 * Unlike Stage-2a's flat-semantic note vocabulary (one class per whole note event), chords are
 * open-vocabulary — `Bb13#11`, `F#m7b5`, `Ab/Eb` — so the model reads them the way OCR does, one
 * **glyph character at a time** (`Δ`, `ø`, `♭`, digits, letters, `/`, parens), and the decoded string
 * is what lands in `bandTokens` for the V5 grammar corrector to normalise (ADR-0011). That is the
 * whole design: the recogniser transcribes what is drawn, it does not classify chords, so the
 * corrector and V13's beat mapping ride on top unchanged.
 *
 * The alphabet is **closed and complete by construction**, the same discipline `vocab.ts` uses: it is
 * every character `chordGlyphText` (`@sibei/engrave`) can draw for a chord in `enumerateChordSpace`
 * (`chords.ts`) under any label-affecting `ChordStyle`. Since `chordGlyphText` is the same code that
 * inks the pixels, the training label and the rendered glyphs cannot drift. Id 0 is the CTC blank; id
 * 1 is a chord **separator** so a band of several chords decodes back into distinct symbols (CTC
 * collapses the blank runs between them, which would otherwise fuse `C` and `G7` into `CG7`).
 *
 * Framework-free, Node-free plain TypeScript (`@sibei/engrave` is pure — it emits markup, loading no
 * native binding — so this stays safe for the fast test layer).
 */

import type { ChordStyle } from '@sibei/engrave';
import { CANONICAL_CHORD_STYLE, chordGlyphText } from '@sibei/engrave';
import { formatChord } from '@sibei/music';
import { enumerateChordSpace } from './chords.js';

/** The CTC blank, always id 0 (PyTorch `nn.CTCLoss(blank=0)`). Local: the note vocab exports the same name. */
const BLANK_SYMBOL = '<blank>';
/** The chord separator, id 1 — emitted between adjacent chords in a band so they stay distinct. */
export const CHORD_SEP_SYMBOL = '<sep>';

/**
 * Styles that between them exercise every label-affecting choice, each varied from the canonical one
 * axis at a time. That is enough to surface every character (a glyph is introduced by a single axis —
 * `M` by `majorSeventh:'M'`, `♭` by a `glyph` accidental, `(` by parenthesising), without the full
 * 768-way cross-product. `stackAlterations`/`triangleScale` are omitted: they move pixels, not text.
 */
function labelStyleMatrix(): ChordStyle[] {
  const c = CANONICAL_CHORD_STYLE;
  const variants: Partial<ChordStyle>[] = [
    {},
    { majorSeventh: 'maj' },
    { majorSeventh: 'ma' },
    { majorSeventh: 'M' },
    { minor: 'min' },
    { minor: 'dash' },
    { halfDiminished: 'spell' },
    { diminished: 'dim' },
    { augmented: 'aug' },
    { rootAccidental: 'glyph' },
    { tensionAccidental: 'ascii' },
    { parenthesizeAlterations: false },
  ];
  return variants.map((v) => ({ ...c, ...v }));
}

/**
 * Additive, versioned vocabulary extensions (SIB2-203). Version 1 is the shipped alphabet and its ids
 * are frozen: `chord.onnx` + `chord-vocab.json` are a matched pair, so a vocabulary change must never
 * renumber an existing class. A later version only APPENDS its new characters after every earlier
 * id, in the order listed here, so a version-1 model's class ids stay valid inside a version-2 table.
 * (A version-N model still needs a retrain to emit the new classes — that is a separate decision.)
 *
 *   2: `' '` — the member separator inside a parenthesised alternate, `(Gm7 C7)`.
 */
export const CHORD_VOCAB_EXTENSIONS: Readonly<Record<number, readonly string[]>> = { 2: [' '] };
export const LATEST_CHORD_VOCAB_VERSION = 2;

export interface BuildChordVocabularyOptions {
  /** The vocabulary version to build (default 1, the shipped alphabet, byte-identical to before). */
  version?: number;
}

export interface ChordVocabulary {
  /** Which versioned alphabet this is; 1 is the shipped one. */
  readonly version: number;
  /** `symbols[id]` — id 0 is the blank, id 1 the separator, then one entry per glyph character. */
  readonly symbols: readonly string[];
  readonly size: number;
  readonly blank: number;
  readonly sep: number;
  /** The class id of a single glyph character, or undefined if outside the alphabet. */
  idOfChar(ch: string): number | undefined;
  /** Char-id sequence for one rendered chord glyph string. Throws on an unknown character (drift bug). */
  encodeChord(glyphText: string): number[];
  /** Char-id sequence for a whole band: chords in reading order, joined by the separator id. */
  encodeBand(glyphTexts: readonly string[]): number[];
}

/**
 * Build the closed character alphabet: every glyph character any styled render of any enumerable chord
 * can draw. De-duplicated, sorted for a stable manifest, with the blank at 0 and the separator at 1.
 */
export function buildChordVocabulary(options: BuildChordVocabularyOptions = {}): ChordVocabulary {
  const version = options.version ?? 1;
  if (!Number.isInteger(version) || version < 1 || version > LATEST_CHORD_VOCAB_VERSION) {
    throw new Error(`unknown chord vocabulary version: ${version}`);
  }
  const styles = labelStyleMatrix();
  const chars = new Set<string>();
  for (const structure of enumerateChordSpace()) {
    const text = formatChord({ kind: 'chord', structure });
    for (const style of styles) {
      for (const ch of chordGlyphText(text, style)) chars.add(ch);
    }
  }

  const symbols = [BLANK_SYMBOL, CHORD_SEP_SYMBOL, ...[...chars].sort()];
  // Appended, never sorted in: existing ids stay put (see CHORD_VOCAB_EXTENSIONS).
  for (let v = 2; v <= version; v += 1) {
    for (const ch of CHORD_VOCAB_EXTENSIONS[v] ?? []) if (!symbols.includes(ch)) symbols.push(ch);
  }
  const idByChar = new Map(symbols.map((symbol, id) => [symbol, id] as const));
  const blank = 0;
  const sep = 1;

  const idOfChar = (ch: string): number | undefined => idByChar.get(ch);

  const encodeChord = (glyphText: string): number[] =>
    [...glyphText].map((ch) => {
      const id = idByChar.get(ch);
      if (id === undefined) {
        throw new Error(`chord character not in vocabulary: ${JSON.stringify(ch)}`);
      }
      return id;
    });

  const encodeBand = (glyphTexts: readonly string[]): number[] => {
    const out: number[] = [];
    glyphTexts.forEach((text, i) => {
      if (i > 0) out.push(sep);
      out.push(...encodeChord(text));
    });
    return out;
  };

  return { version, symbols, size: symbols.length, blank, sep, idOfChar, encodeChord, encodeBand };
}
