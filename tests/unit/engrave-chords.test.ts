import { chordSymbol, serialise } from '@sibei/engrave';
import { describe, expect, it } from 'vitest';

/**
 * Jazz chord typography through the engraver (V5, ADR-0030). The grammar (`@sibei/music`) tells
 * the engraver what a symbol *is*, and this file pins how each kind is drawn: the `Δ` of a major
 * seventh, the `ø` of a half-diminished chord, superscripted tensions, parenthesised and stacked
 * alterations, and the verbatim fallback for anything the grammar cannot read.
 *
 * These assert the markup rather than the pixels, which is the same division of labour the rest of
 * the engraver tests keep: the glyph shapes are the font's, and what is worth pinning is the
 * structure the engraver builds from — nothing here measures.
 */

function render(text: string, plain = false): string {
  return serialise(chordSymbol({ text, x: 0, y: 0, size: 14, plain }));
}

describe('the jazz quality glyphs', () => {
  it('draws a major seventh as Δ, with the number superscripted', () => {
    const svg = render('Ebmaj7');
    expect(svg).toContain('>EbΔ<');
    expect(svg).toMatch(/<tspan[^>]*dy="-[0-9.]+"[^>]*>7<\/tspan>/);
  });

  it('draws a half-diminished chord as ø, dropping the m and the b5 it already means', () => {
    const svg = render('F#m7b5');
    expect(svg).toContain('>F#ø<');
    expect(svg).not.toContain('b5');
    expect(svg).not.toContain('♭5');
  });

  it('draws a diminished seventh as °', () => {
    expect(render('Bdim7')).toContain('>B°<');
  });

  it('keeps a plain minor and dominant as m and a bare superscript', () => {
    expect(render('Cm7')).toContain('>Cm<');
    expect(render('C7')).toMatch(/>C<tspan[^>]*>7<\/tspan>/);
  });
});

describe('extensions, alterations, and the bass', () => {
  it('parenthesises a single altered extension, with a real accidental glyph', () => {
    const svg = render('Bb13#11');
    expect(svg).toContain('13(♯11)');
  });

  it('stacks two or more alterations, the lower one slid back under the upper', () => {
    const svg = render('C7#9b13');
    // Top line carries the seventh and the first alteration; the second rides below it with a
    // negative dx (slid left to line up) and a positive dy (dropped a line).
    expect(svg).toContain('>7♯9<');
    expect(svg).toMatch(/<tspan[^>]*dy="[0-9.]+"[^>]*dx="-[0-9.]+"[^>]*>♭13<\/tspan>/);
  });

  it('renders the alt shorthand as a superscript', () => {
    expect(render('C7alt')).toMatch(/<tspan[^>]*>7alt<\/tspan>/);
  });

  it('keeps a slash bass at full size on the baseline', () => {
    const svg = render('Ab/Eb');
    expect(svg).toContain('>Ab/Eb<');
    expect(svg).not.toContain('tspan');
  });
});

describe('what the grammar cannot read is drawn verbatim', () => {
  it('leaves N.C. whole rather than superscripting half of it', () => {
    const svg = render('N.C.');
    expect(svg).toContain('>N.C.<');
    expect(svg).not.toContain('tspan');
  });

  it('leaves unparseable text and plain annotations untouched', () => {
    expect(render('solo break')).toContain('>solo break<');
    expect(render('to Coda', true)).toContain('>to Coda<');
    // A plain annotation carries the annotation class, not the chord class.
    expect(render('to Coda', true)).toContain('se-annotation');
  });
});
