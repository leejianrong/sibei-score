import { correctChord } from '@sibei/music';
import { describe, expect, it } from 'vitest';

/**
 * The grammar corrector (ADR-0011). These are realistic OCR mangles of chord symbols — the kind a
 * general recogniser produces on a phone photo of a chart — each snapped to the chord it was meant
 * to be. This suite is the corrector's half of V5's double duty: it is the acceptance test V13's
 * import pipeline will be measured against.
 */

describe('snapping OCR mangles to the nearest legal chord (ADR-0011)', () => {
  const cases: [mangle: string, corrected: string][] = [
    // Glyph confusions: S/5, l/1, l/i, I/1, J/j.
    ['Cm7bS', 'Cm7b5'],
    ['Dm7bs', 'Dm7b5'],
    ['F#m7bS', 'F#m7b5'],
    ['Bl3#11', 'B13#11'],
    ['Cl3', 'C13'],
    ['Cdlm7', 'Cdim7'],
    ['AbmaJ7', 'Abmaj7'],
    // Casing and whitespace, which never change a chord's meaning.
    ['cmaj7', 'Cmaj7'],
    ['ab/eb', 'Ab/Eb'],
    ['C m7 b5', 'Cm7b5'],
    ['  Bb13#11  ', 'Bb13#11'],
    // Already legal: canonicalised, not altered.
    ['CM7', 'Cmaj7'],
    ['Cø', 'Cm7b5'],
    ['N.C.', 'N.C.'],
  ];

  for (const [mangle, corrected] of cases) {
    it(`${JSON.stringify(mangle)} -> ${corrected}`, () => {
      expect(correctChord(mangle)).toBe(corrected);
    });
  }

  it('gives up rather than inventing harmony', () => {
    // No small glyph correction turns these into a chord, so the corrector declines and the
    // caller keeps them verbatim and flagged — the corrector never guesses a quality.
    for (const hopeless of ['solo break', 'x y z', '####', 'Coda']) {
      expect(correctChord(hopeless)).toBeNull();
    }
  });

  it('prefers the least-corrected reading', () => {
    // `Cl1` could snap to `C11` (l->1) or `Ci1`->nothing; the one-substitution reading that
    // parses wins, and a spelling already legal is returned before any substitution is tried.
    expect(correctChord('C7')).toBe('C7');
    expect(correctChord('Cl1')).toBe('C11');
  });
});
