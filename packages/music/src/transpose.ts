import { transposeSpelling } from '@sibei/model';
import type { Interval, KeySignature } from '@sibei/model';
import { formatChord } from './format.js';
import { parseChord } from './parse.js';

/**
 * Transpose a chord *symbol* — the one piece of transposition that needs the grammar (ADR-0016).
 * A chord root is a spelling (`@sibei/model` moves those), but only the grammar can pull the root
 * out of the text and put a moved one back, so this is where the two meet, and it lives in `music`
 * so the concert-key `transpose` op and the instrument-part render-time view share one copy rather
 * than each keeping their own.
 *
 * The root and any slash bass move by the interval, respelled by the destination key (ADR-0017).
 * Text the grammar cannot read, and `N.C.`, come back unchanged: there is no root to move, and an
 * unparseable symbol stays verbatim and flagged exactly as it was stored (ADR-0012). A parsed chord
 * is re-emitted through `formatChord`, so it is written in the grammar's one canonical spelling —
 * the price of transposing structure rather than juggling substrings.
 *
 * Chords carry no spelling pin yet, so every root respells by the key; the per-chord override is a
 * document-shape change that arrives with its migration in a later slice (ADR-0017, ADR-0028).
 */
export function transposeChordText(text: string, interval: Interval, key: KeySignature): string {
  const parsed = parseChord(text);
  if (parsed === null || parsed.kind === 'no-chord') return text;
  const s = parsed.structure;
  return formatChord({
    kind: 'chord',
    structure: {
      ...s,
      root: transposeSpelling(s.root, interval, key),
      bass: s.bass === null ? null : transposeSpelling(s.bass, interval, key),
    },
  });
}
