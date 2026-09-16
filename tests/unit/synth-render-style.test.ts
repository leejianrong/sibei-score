import { CANONICAL_CHORD_STYLE, chordGlyphText } from '@sibei/engrave';
import { makeRng, randomChordStyle, randomMusicFont, randomRenderStyle } from '@sibei/synth';
import { describe, expect, it } from 'vitest';

/**
 * Per-seed render randomisation (V17a, ADR-0031). This is the pure half — the choices, not the
 * pixels: that the same seed yields the same style (the determinism the whole corpus rests on), that
 * across seeds the corpus actually varies both the face and the symbology (the point of the axis),
 * and that every style it picks is a legal one `chordGlyphText` can spell.
 */

describe('determinism', () => {
  it('yields the identical style for the same seed', () => {
    expect(randomRenderStyle(makeRng(42))).toEqual(randomRenderStyle(makeRng(42)));
    expect(randomChordStyle(makeRng(7))).toEqual(randomChordStyle(makeRng(7)));
    expect(randomMusicFont(makeRng(99))).toBe(randomMusicFont(makeRng(99)));
  });
});

describe('coverage across seeds', () => {
  const styles = Array.from({ length: 200 }, (_, seed) => randomRenderStyle(makeRng(seed)));

  it('exercises both music faces', () => {
    const faces = new Set(styles.map((s) => s.font));
    // The faces are named for their role, not their font: `normal` is Bravura, `jazz` is Petaluma.
    expect(faces).toContain('normal');
    expect(faces).toContain('jazz');
  });

  it('exercises every major-seventh spelling and both half-diminished forms', () => {
    const chordStyles = Array.from({ length: 400 }, (_, seed) =>
      randomChordStyle(makeRng(seed)),
    );
    const maj = new Set(chordStyles.map((s) => s.majorSeventh));
    expect(maj).toEqual(new Set(['delta', 'maj', 'ma', 'M']));
    const halfDim = new Set(chordStyles.map((s) => s.halfDiminished));
    expect(halfDim).toEqual(new Set(['circle', 'spell']));
  });

  // The `styles` array above is a smoke that construction does not throw; it is not asserted on
  // directly, only that a broad sweep produces variety.
  it('produces more than one distinct chord style over a sweep', () => {
    const distinct = new Set(styles.map((s) => JSON.stringify(s.chordStyle)));
    expect(distinct.size).toBeGreaterThan(10);
  });
});

describe('every randomised style spells a legal chord', () => {
  it('renders a representative chord under 100 random styles without producing empty text', () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const style = randomChordStyle(makeRng(seed));
      for (const chord of ['Cmaj7', 'F#m7b5', 'Bdim7', 'C7#9b13', 'Ab/Eb']) {
        const drawn = chordGlyphText(chord, style);
        expect(drawn.length).toBeGreaterThan(0);
        // The root letter always survives whatever the symbology.
        expect(drawn[0]).toBe(chord[0]);
      }
    }
  });

  it('the canonical style is a valid input and matches the engraver default', () => {
    expect(chordGlyphText('Ebmaj7', CANONICAL_CHORD_STYLE)).toBe('EbΔ7');
  });
});
