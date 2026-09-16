/**
 * Locate the vendored text-font files for the rasteriser (V17a-iii, ADR-0031). The TTFs in
 * `assets/fonts/` are handed to `@resvg/resvg-js` as `fontFiles`, so the corpus's *primary* text
 * typeface — a title or a chord symbol drawn in `textFont` — is deterministic (always vendored)
 * rather than whatever serif a given machine happens to have installed. System fonts stay loaded
 * (`loadSystemFonts: true`) as a fallback for the rare glyph a text face lacks (notably the music
 * flat `♭`, in none of them), so this only *adds* determinism where the corpus had none, and regresses
 * nothing. Which family a chart uses is chosen in the pure core (`text-fonts.ts`); resvg resolves the
 * SVG's `font-family` against these files by each TTF's own internal family name.
 *
 * resvg-js 2.6.2 takes font *paths*, not buffers, so this returns paths. Node-only, which is why it
 * lives in the `@sibei/synth/imaging` half and not the pure barrel. The list is read once and cached.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FONTS_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));

let cache: string[] | undefined;

/** Absolute paths of the vendored text-font TTFs, read once. Empty if the assets directory is absent. */
export function textFontFiles(): string[] {
  if (cache !== undefined) return cache;
  let files: string[];
  try {
    files = readdirSync(FONTS_DIR).filter((name) => name.toLowerCase().endsWith('.ttf'));
  } catch {
    // No assets directory (e.g. a stripped checkout): fall back to system fonts alone.
    cache = [];
    return cache;
  }
  files.sort(); // deterministic order, so the resvg font database is built the same way every run.
  cache = files.map((name) => join(FONTS_DIR, name));
  return cache;
}
