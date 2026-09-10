import { formatAlter } from '@sibei/model';
import type { Alteration, Chord, ChordStructure, Root } from './chord.js';

/**
 * Render a parsed chord back to text, one canonical spelling per structure (ADR-0012). This is
 * the "write strictly" half of the grammar: `parseChord` takes `CM7`, `Cma7` and `CΔ` alike, and
 * `formatChord` turns all three back into `Cmaj7`. So the round-trip a caller relies on is
 * `parseChord(formatChord(structure))` reproducing the structure — canonicalisation, not string
 * identity, since the input spelling is deliberately forgotten.
 *
 * The half-diminished `ø`, the diminished `°`, the maj7 `Δ` and the rest of the jazz *glyphs*
 * are the engraver's job (V5d, ADR-0030): they are typography over this structure, not spelling,
 * so this stays in plain ASCII a CLI and a text projection can print anywhere.
 */
export function formatChord(chord: Chord): string {
  if (chord.kind === 'no-chord') return 'N.C.';
  const s = chord.structure;
  return `${formatRoot(s.root)}${quality(s)}${s.bass === null ? '' : `/${formatRoot(s.bass)}`}`;
}

export function formatRoot(root: Root): string {
  return `${root.step}${formatAlter(root.alter)}`;
}

/** Everything between the root and the slash bass: quality, extension, alterations, sus, adds. */
function quality(s: ChordStructure): string {
  if (s.alt) return '7alt';

  // A 6/9 is a sixth chord whose ninth folds into the quality (`C6/9`, `Cm6/9`); any other
  // addition trails as `addN`. It is a sixth only, never over a seventh or a suspension.
  const sixNine =
    s.sixth && s.seventh === null && s.suspension === null && !s.power && s.additions.includes(9);
  const trailingAdds = s.additions.filter((degree) => !(sixNine && degree === 9));

  const core = s.suspension !== null ? suspensionCore(s) : sixNine ? `${triadLetters(s.triad)}6/9` : seventhCore(s);
  const alterations = orderedAlterations(s.alterations)
    .map((a) => `${a.alter < 0 ? 'b' : '#'}${a.degree}`)
    .join('');
  const adds = trailingAdds.map((degree) => `add${degree}`).join('');

  return `${core}${alterations}${suspensionTail(s)}${adds}`;
}

/**
 * The quality core for a suspended chord: the third is gone, so the minor/major triad letters do
 * not apply — only the seventh number (if any) and the `sus`. `sus` itself trails in
 * `suspensionTail` so an alteration like `C7sus4` orders as `7` `sus4` and not `7sus4b9` nonsense.
 */
function suspensionCore(s: ChordStructure): string {
  if (s.seventh !== null) return String(s.extension ?? 7);
  if (s.sixth) return '6';
  return '';
}

function suspensionTail(s: ChordStructure): string {
  return s.suspension ?? '';
}

/** The quality core for an ordinary (un-suspended) chord. */
function seventhCore(s: ChordStructure): string {
  const top = s.extension ?? 7;

  if (s.seventh === null) {
    const base = triadLetters(s.triad);
    if (s.sixth) return `${base}6`;
    if (s.power) return `${base}5`;
    return base;
  }
  if (s.seventh === 'diminished') return `dim${top}`;
  if (s.seventh === 'major') {
    switch (s.triad) {
      case 'major':
        return `maj${top}`;
      case 'minor':
        return `mMaj${top}`;
      case 'augmented':
        return `augMaj${top}`;
      case 'diminished':
        return `dimMaj${top}`;
    }
  }
  // A minor (flat) seventh: the dominant, and the seventh of a minor or augmented chord.
  return `${triadLetters(s.triad)}${top}`;
}

function triadLetters(triad: ChordStructure['triad']): string {
  switch (triad) {
    case 'major':
      return '';
    case 'minor':
      return 'm';
    case 'diminished':
      return 'dim';
    case 'augmented':
      return 'aug';
  }
}

/** Low degrees first, so `C7b9#11` reads `b9` then `#11` however they were typed. */
function orderedAlterations(alterations: readonly Alteration[]): Alteration[] {
  return [...alterations].sort((a, b) => a.degree - b.degree);
}
