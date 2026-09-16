import type { ChordStyle } from '@sibei/engrave';
import { CANONICAL_CHORD_STYLE, chordGlyphText, chordSymbol, serialise } from '@sibei/engrave';
import { describe, expect, it } from 'vitest';

/**
 * Chord-symbol typography as a style (V17a, ADR-0031). The same structure prints many ways on real
 * charts — `Δ` or the word `maj`, `ø` or a spelled `m7♭5`, glyph or ASCII accidentals — and the OMR
 * training corpus needs that variety (domain randomisation). This pins that the style knob changes
 * the glyphs, that the canonical style is unchanged (byte-identity is asserted elsewhere by the
 * snapshot suite; here we pin the strings), and — the load-bearing invariant — that `chordGlyphText`
 * returns exactly what the SVG draws, so a recogniser's label cannot drift from the pixels.
 */

function render(text: string, style?: ChordStyle): string {
  return serialise(
    chordSymbol({ text, x: 0, y: 0, size: 14, plain: false, ...(style ? { style } : {}) }),
  );
}

/** The visible text of a rendered chord: the SVG with every tag removed. */
function visibleText(text: string, style?: ChordStyle): string {
  return render(text, style).replace(/<[^>]*>/g, '');
}

const style = (overrides: Partial<ChordStyle>): ChordStyle => ({
  ...CANONICAL_CHORD_STYLE,
  ...overrides,
});

describe('the major-seventh marker', () => {
  it('spells maj7 as a word when asked', () => {
    expect(render('Cmaj7', style({ majorSeventh: 'maj' }))).toContain('>Cmaj<');
    expect(render('Cmaj7', style({ majorSeventh: 'M' }))).toContain('>CM<');
    expect(render('Cmaj7', style({ majorSeventh: 'ma' }))).toContain('>Cma<');
  });

  it('draws a smaller triangle as its own tspan when triangleScale is not 1', () => {
    const svg = render('Cmaj7', style({ triangleScale: 0.7 }));
    expect(svg).toMatch(/<tspan[^>]*font-size="[0-9.]+px"[^>]*>Δ<\/tspan>/);
    // Still spells to the same label — the triangle is a triangle whatever its size.
    expect(chordGlyphText('Cmaj7', style({ triangleScale: 0.7 }))).toBe('CΔ7');
  });
});

describe('the other quality markers', () => {
  it('spells a half-diminished chord as m7♭5 under the spell style, keeping the ♭5', () => {
    const s = style({ halfDiminished: 'spell' });
    const svg = render('F#m7b5', s);
    expect(svg).toContain('>F#m<');
    expect(svg).not.toContain('ø');
    expect(svg).toContain('♭5');
    expect(chordGlyphText('F#m7b5', s)).toBe('F#m7(♭5)');
  });

  it('spells diminished and augmented as words', () => {
    expect(render('Bdim7', style({ diminished: 'dim' }))).toContain('>Bdim<');
    expect(render('Caug', style({ augmented: 'aug' }))).toContain('>Caug<');
  });

  it('varies the minor marker between m, min and a dash', () => {
    expect(render('Cm7', style({ minor: 'min' }))).toContain('>Cmin<');
    expect(render('Cm7', style({ minor: 'dash' }))).toContain('>C-<');
  });
});

describe('accidentals', () => {
  it('draws the root accidental as a glyph when asked (E♭ vs Eb)', () => {
    expect(render('Ebmaj7', style({ rootAccidental: 'glyph' }))).toContain('>E♭Δ<');
    // The default keeps the historical ASCII root.
    expect(render('Ebmaj7')).toContain('>EbΔ<');
  });

  it('draws tension accidentals as ASCII when asked (b9 vs ♭9)', () => {
    const svg = render('C7b9', style({ tensionAccidental: 'ascii' }));
    expect(svg).toContain('b9');
    expect(svg).not.toContain('♭9');
  });
});

describe('alteration layout', () => {
  it('drops the parentheses around an inline alteration when asked', () => {
    expect(render('Bb13#11', style({ parenthesizeAlterations: false }))).toContain('13♯11');
    expect(render('Bb13#11', style({ parenthesizeAlterations: false }))).not.toContain('(');
  });

  it('runs two alterations inline rather than stacking when stackAlterations is off', () => {
    const s = style({ stackAlterations: false });
    const svg = render('C7#9b13', s);
    // No stacked second line: the drop-a-line dy of the stacked path is absent.
    expect(svg).not.toMatch(/dy="[0-9]/);
    expect(chordGlyphText('C7#9b13', s)).toBe('C7(♯9♭13)');
  });
});

describe('chordGlyphText is exactly what the SVG draws', () => {
  const styles: ChordStyle[] = [
    CANONICAL_CHORD_STYLE,
    style({ majorSeventh: 'maj', halfDiminished: 'spell', diminished: 'dim', augmented: 'aug' }),
    style({ minor: 'min', rootAccidental: 'glyph', tensionAccidental: 'ascii' }),
    style({ stackAlterations: false, parenthesizeAlterations: false, triangleScale: 0.6 }),
  ];
  const chords = [
    'C',
    'Cmaj7',
    'Ebmaj7',
    'F#m7b5',
    'Bdim7',
    'Caug',
    'C7',
    'C7alt',
    'Bb13#11',
    'C7#9b13',
    'Ab/Eb',
    'Cm7',
  ];

  for (const s of styles) {
    for (const chord of chords) {
      it(`${chord} @ ${JSON.stringify(pick(s))}`, () => {
        expect(chordGlyphText(chord, s)).toBe(visibleText(chord, s));
      });
    }
  }
});

/** The style fields that differ from canonical, for a readable test name. */
function pick(s: ChordStyle): Partial<ChordStyle> {
  const diff: Partial<ChordStyle> = {};
  for (const key of Object.keys(s) as (keyof ChordStyle)[]) {
    if (s[key] !== CANONICAL_CHORD_STYLE[key]) (diff as Record<string, unknown>)[key] = s[key];
  }
  return diff;
}
