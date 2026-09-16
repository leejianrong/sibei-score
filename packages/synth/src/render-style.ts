/**
 * Per-seed render randomisation — how a chart is *drawn*, as opposed to what music it contains
 * (`generate.ts`). This is the domain-randomisation axis V15/V16 planned but never applied: every
 * earlier corpus rendered in one music face (Bravura) with one canonical chord symbology, so a
 * recogniser trained on it overfits that face and those glyphs (V17a, ADR-0031). Vary the drawing,
 * hold the labels, and the model learns the music instead of the typography.
 *
 * Two axes live here and are font-free, so they render deterministically on any machine with no
 * vendored files: the **music face** (Bravura vs Petaluma — noteheads are embedded SVG paths, not
 * font references, so a face is just a different path set) and the **chord symbology** (Δ vs the word
 * `maj`, ø vs a spelled `m7♭5`, glyph vs ASCII accidentals, and so on — `ChordStyle` from
 * `@sibei/engrave`). The third axis, the *text typeface*, needs vendored font files and is added
 * separately (V17a-iii). `@sibei/engrave` is pure TypeScript (it emits markup, loading no native
 * binding), so importing it keeps this barrel safe for the fast test layer.
 *
 * Framework-free, Node-free plain TypeScript, and — like everything in the core — deterministic in
 * the `Rng` handed in: the same seed yields the same style.
 */

import type { ChordStyle, MusicFontName } from '@sibei/engrave';
import { MUSIC_FONT_NAMES } from '@sibei/engrave';
import type { Rng } from './rng.js';
import { constrainSymbology, randomTextFace } from './text-fonts.js';

/** The drawing choices for one rendered chart: music face, chord symbology, and text typeface. */
export interface RenderStyle {
  font: MusicFontName;
  chordStyle: ChordStyle;
  /** The text font family for the title block and chord symbols (V17a-iii). */
  textFont: string;
}

/**
 * mulberry32's first output is poorly dispersed for sequential seeds (`makeRng(0)`, `makeRng(1)`, …
 * land in the same half), which would bias a first-draw binary choice like the music face toward one
 * value across a corpus. One discarded draw moves past it — the same reason the degrade path salts its
 * seed. Kept here so a caller may hand in a raw `makeRng(seed)` and still get an even spread.
 */
function warm(rng: Rng): Rng {
  rng.next();
  return rng;
}

/** A music face, both weighted equally — a lead sheet is as often handwritten (Petaluma) as engraved. */
export function randomMusicFont(rng: Rng): MusicFontName {
  return warm(rng).pick(MUSIC_FONT_NAMES);
}

/**
 * A random chord symbology. Weighted toward the conventional jazz glyphs (Δ, ø, °, +, `♭`/`♯`) so the
 * corpus is dominated by what a reader most often meets, while still covering the spelled and ASCII
 * variants a recogniser must not choke on. Every combination is a legal spelling of the same
 * structure; the `Chord.text` label is unchanged, and `chordGlyphText` reads back exactly what a
 * given style draws (V17b).
 */
export function randomChordStyle(rng: Rng): ChordStyle {
  warm(rng);
  return {
    majorSeventh: rng.weighted(['delta', 'maj', 'ma', 'M'], [5, 3, 1, 1]),
    minor: rng.weighted(['m', 'min', 'dash'], [6, 2, 1]),
    halfDiminished: rng.weighted(['circle', 'spell'], [3, 1]),
    diminished: rng.weighted(['circle', 'dim'], [3, 2]),
    augmented: rng.weighted(['plus', 'aug'], [3, 2]),
    rootAccidental: rng.weighted(['ascii', 'glyph'], [1, 1]),
    tensionAccidental: rng.weighted(['glyph', 'ascii'], [2, 1]),
    parenthesizeAlterations: rng.bool(0.7),
    stackAlterations: rng.bool(0.5),
    triangleScale: rng.weighted([1, 0.85, 0.75], [3, 1, 1]),
  };
}

/**
 * A full render style: a music face, a text typeface, and a chord symbology, all drawn from the one
 * `Rng`. The symbology is constrained to what the chosen typeface can draw (a handwriting face has no
 * `Δ`), so nothing renders as tofu — the corpus's soundness rests on this (V17a-iii).
 */
export function randomRenderStyle(rng: Rng): RenderStyle {
  const font = randomMusicFont(rng);
  const face = randomTextFace(rng);
  const chordStyle = constrainSymbology(face, randomChordStyle(rng));
  return { font, chordStyle, textFont: face.family };
}
