/**
 * The vendored text typefaces the corpus draws chord symbols and titles in (V17a-iii, ADR-0031) —
 * the third domain-randomisation axis, after the music face and the chord symbology. The TTFs live
 * in `assets/fonts/` and are loaded into the rasteriser by `imaging/fonts.ts`; this pure module owns
 * only the *choice*: which families exist, and which glyphs each can draw.
 *
 * The capability table is load-bearing. A face that lacks a glyph would render tofu into the training
 * data, so the symbology is constrained to what the chosen face actually carries: all four faces have
 * `ø`/`°`/ASCII `b`/`#`, but only the serif/sans carry `Δ` (U+0394), so a handwriting face falls back
 * to a spelled major seventh. The music flat `♭` (U+266D) is in none of them and resolves through the
 * system fonts at render time, exactly as the corpus did before this axis existed — see
 * `assets/fonts/SOURCES.md`.
 *
 * Framework-free, Node-free plain TypeScript, deterministic in the `Rng` handed in.
 */

import type { ChordStyle } from '@sibei/engrave';
import type { Rng } from './rng.js';

/** One vendored text face and the coverage that bounds the symbology drawn in it. */
export interface TextFace {
  /** The font-family string; matches the TTF's internal family name, which is how resvg resolves it. */
  family: string;
  /** Whether the face carries the `Δ` (U+0394) glyph. The handwriting faces do not. */
  supportsDelta: boolean;
}

/**
 * The vendored faces, verified with fontkit (`assets/fonts/SOURCES.md`): two engraved (a serif and a
 * sans) and two handwritten, so a chart is drawn in a printed *or* a Real-Book-ish hand.
 */
export const TEXT_FACES: readonly TextFace[] = [
  { family: 'Tinos', supportsDelta: true },
  { family: 'Arimo', supportsDelta: true },
  { family: 'Patrick Hand', supportsDelta: false },
  { family: 'Caveat', supportsDelta: false },
];

/**
 * Constrain a chord symbology to what a face can draw, so nothing renders as tofu. Today that is one
 * rule — a face without `Δ` spells the major seventh as a word — but the table is where any further
 * per-face gap is handled, keeping the coupling in one place rather than scattered through the caller.
 */
export function constrainSymbology(face: TextFace, style: ChordStyle): ChordStyle {
  if (!face.supportsDelta && style.majorSeventh === 'delta') {
    return { ...style, majorSeventh: 'maj' };
  }
  return style;
}

/** A random text face. Weighted toward the engraved faces, which are the common case on a printed chart. */
export function randomTextFace(rng: Rng): TextFace {
  // One discarded draw sidesteps mulberry32's sequential-seed first-draw correlation, so a raw
  // `makeRng(seed)` still spreads across faces — the same reason `render-style.ts` warms its draws.
  rng.next();
  return rng.weighted(TEXT_FACES, [4, 3, 2, 2]);
}
