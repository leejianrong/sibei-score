import type { MusicFont, MusicFontData } from '../font.js';
import { musicFont } from '../font.js';
import { BRAVURA } from './bravura.generated.js';
import { PETALUMA } from './petaluma.generated.js';

/**
 * The faces a score can be engraved in.
 *
 * A lead sheet is read in a handwritten Real Book face as often as an engraved one, and
 * which one is the reader's choice at render time — so this is a lookup, not a build-time
 * constant. Adding the jazz face is one entry in the table below plus its vendored slice.
 *
 * Each entry is generated data rather than a font file: the product neither loads nor
 * embeds a font, which is what keeps rendering identical in a browser, in a test and in a
 * PDF (`docs/v1-render-gate.md`).
 */

export type MusicFontName = 'normal' | 'jazz';

/**
 * `normal` is Bravura, SMuFL's reference face, so it is the baseline. `jazz` is Petaluma,
 * Steinberg's handwritten face — the Real Book look, which for a jazz lead sheet is the
 * point rather than the option (ADR-0030).
 */
const FACES: Readonly<Record<MusicFontName, MusicFontData>> = {
  normal: BRAVURA,
  jazz: PETALUMA,
};

export const MUSIC_FONT_NAMES = Object.keys(FACES) as readonly MusicFontName[];

export const DEFAULT_MUSIC_FONT: MusicFontName = 'normal';

// Resolving a face builds one small object. Caching it keeps a page render from
// rebuilding it per system.
const CACHE = new Map<MusicFontName, MusicFont>();

export function musicFontNamed(name: MusicFontName = DEFAULT_MUSIC_FONT): MusicFont {
  const cached = CACHE.get(name);
  if (cached !== undefined) return cached;
  const font = musicFont(FACES[name]);
  CACHE.set(name, font);
  return font;
}

export { BRAVURA, PETALUMA };
