import { CANONICAL_CHORD_STYLE, chordGlyphText } from '@sibei/engrave';
import { formatChord } from '@sibei/music';
import {
  buildChordVocabulary,
  enumerateChordSpace,
  extractSystemChords,
  generateScore,
  makeRng,
  randomChordStructure,
  randomRenderStyle,
} from '@sibei/synth';
import { describe, expect, it } from 'vitest';

/**
 * The Stage-2b chord-band corpus's pure half (V17b, ADR-0031): the character CTC vocabulary and the
 * per-system chord labels. The load-bearing property is that the vocabulary is closed — every chord
 * the generator can draw, in every style it can be drawn, tokenises without falling outside it — and
 * that the labels are the glyph strings actually drawn, in reading (x) order.
 */

describe('buildChordVocabulary', () => {
  const vocab = buildChordVocabulary();

  it('reserves the blank and the separator, then glyph characters', () => {
    expect(vocab.blank).toBe(0);
    expect(vocab.sep).toBe(1);
    expect(vocab.symbols[0]).toBe('<blank>');
    expect(vocab.symbols[1]).toBe('<sep>');
    // The jazz glyphs a chord can carry are all present.
    for (const g of ['Δ', 'ø', '°', '♭', '♯']) expect(vocab.symbols).toContain(g);
  });

  it('is deterministic', () => {
    expect(buildChordVocabulary().symbols).toEqual(vocab.symbols);
  });

  it('is closed: every enumerable chord in every label style tokenises', () => {
    // The same single-axis style variation the vocab was built from — encoding must never throw.
    const styles = [
      CANONICAL_CHORD_STYLE,
      { ...CANONICAL_CHORD_STYLE, majorSeventh: 'M' as const },
      { ...CANONICAL_CHORD_STYLE, halfDiminished: 'spell' as const },
      { ...CANONICAL_CHORD_STYLE, rootAccidental: 'glyph' as const, tensionAccidental: 'ascii' as const },
    ];
    for (const structure of enumerateChordSpace()) {
      const text = formatChord({ kind: 'chord', structure });
      for (const style of styles) {
        expect(() => vocab.encodeChord(chordGlyphText(text, style))).not.toThrow();
      }
    }
  });

  it('is closed under the actual random corpus distribution too', () => {
    for (let seed = 0; seed < 300; seed += 1) {
      const structure = randomChordStructure(makeRng(seed));
      const style = randomRenderStyle(makeRng(seed + 1000)).chordStyle;
      const glyph = chordGlyphText(formatChord({ kind: 'chord', structure }), style);
      expect(() => vocab.encodeChord(glyph), glyph).not.toThrow();
    }
  });

  it('encodeBand joins chords with the separator', () => {
    const band = vocab.encodeBand(['C', 'G7']);
    const c = vocab.encodeChord('C');
    const g7 = vocab.encodeChord('G7');
    expect(band).toEqual([...c, vocab.sep, ...g7]);
    expect(vocab.encodeBand([])).toEqual([]);
    expect(vocab.encodeBand(['C'])).toEqual(c);
  });
});

describe('extractSystemChords', () => {
  it('labels each system with its chords in reading order, as the chosen style draws them', () => {
    const score = generateScore({ seed: 3, bars: 8, chords: true });
    const style = { ...CANONICAL_CHORD_STYLE, majorSeventh: 'maj' as const };
    const systems = extractSystemChords(score, { style });
    expect(systems.length).toBeGreaterThan(0);
    // Every system here has chords (the generator put them on).
    for (const system of systems) {
      expect(system.hasBand).toBe(true);
      expect(system.chords.length).toBeGreaterThan(0);
      // Labels are the styled glyph strings, not raw chord text: no `maj7` chord shows a Δ under this style.
      for (const chord of system.chords) expect(chord).not.toContain('Δ');
    }
  });

  it('marks a chordless score as having no band', () => {
    const score = generateScore({ seed: 3, bars: 8, chords: false });
    const systems = extractSystemChords(score);
    for (const system of systems) {
      expect(system.hasBand).toBe(false);
      expect(system.chords).toEqual([]);
    }
  });
});
