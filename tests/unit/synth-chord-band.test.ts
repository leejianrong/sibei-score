import { barViews } from '@sibei/model';
import { createHash } from 'node:crypto';
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

/**
 * SIB2-203: stacked slashes and alternates are opt-in widenings. The non-negotiable part is that a
 * seed which opts into nothing is byte-identical to before — the shipped chord.onnx was trained on
 * that corpus — so a fixed sweep is hashed and the digest pinned. (Recompute only if the corpus is
 * meant to change, and then say so loudly: it invalidates the provenance of every trained weight.)
 */
const PINNED_DIGEST = '325a3ab3be65d4e72c9b1fcde83ac7a84a02db4d49f003da92696e6f9df0023b';
describe('opt-in corpus widening (SIB2-203)', () => {
  const STYLE_SALT = 0x51ac_7b17;
  const sweep = (opts: { alternates?: number; stackedSlash?: number } = {}) =>
    Array.from({ length: 40 }, (_, seed) => ({
      score: generateScore({ seed, bars: 8, ...(opts.alternates ? { alternates: opts.alternates } : {}) }),
      style: randomRenderStyle(makeRng((seed ^ STYLE_SALT) >>> 0), {
        ...(opts.stackedSlash ? { stackedSlash: opts.stackedSlash } : {}),
      }),
    }));

  it('leaves a seeded corpus byte-identical when nothing opts in', () => {
    const digest = createHash('sha256')
      .update(JSON.stringify(sweep()))
      .update(JSON.stringify(buildChordVocabulary().symbols))
      .digest('hex');
    expect(digest).toBe(PINNED_DIGEST);
  });

  it('draws only inline slashes by default, and a mix when asked', () => {
    expect(new Set(sweep().map((s) => s.style.chordStyle.slash))).toEqual(new Set(['inline']));
    const mixed = new Set(sweep({ stackedSlash: 0.5 }).map((s) => s.style.chordStyle.slash));
    expect(mixed).toEqual(new Set(['inline', 'stacked']));
  });

  it('a stacked-slash opt-in changes nothing but the slash', () => {
    const base = sweep();
    const wide = sweep({ stackedSlash: 0.5 });
    base.forEach((b, i) => {
      expect({ ...wide[i]?.style, chordStyle: { ...wide[i]?.style.chordStyle, slash: 'inline' } }).toEqual(b.style);
      expect(wide[i]?.score).toEqual(b.score);
    });
  });

  it('alternates leave the note stream untouched and appear in the chord text', () => {
    const base = sweep();
    const wide = sweep({ alternates: 0.5 });
    let alternates = 0;
    wide.forEach(({ score }, i) => {
      barViews(score).forEach((bar, b) => {
        expect(bar.items).toEqual(barViews(base[i]!.score)[b]?.items);
        for (const chord of bar.chords) if (chord.text.startsWith('(')) alternates += 1;
      });
    });
    expect(alternates).toBeGreaterThan(20);
  });

  it('chordGlyphText reads back an alternate and a stacked slash, and the v2 vocabulary encodes them', () => {
    const v2 = buildChordVocabulary({ version: 2 });
    const stacked = { ...CANONICAL_CHORD_STYLE, slash: 'stacked' as const };
    expect(chordGlyphText('(Gmi7 C7)', stacked)).toBe('(Gm7 C7)');
    expect(chordGlyphText('Bb6/F', stacked)).toBe(chordGlyphText('Bb6/F', CANONICAL_CHORD_STYLE));
    for (const { score, style } of sweep({ alternates: 0.5, stackedSlash: 0.5 })) {
      for (const sys of extractSystemChords(score, { style: style.chordStyle })) {
        for (const text of sys.chords) expect(() => v2.encodeChord(text)).not.toThrow();
      }
    }
  });

  it('the v1 vocabulary refuses an alternate; v2 only appends and never renumbers', () => {
    const v1 = buildChordVocabulary();
    const v2 = buildChordVocabulary({ version: 2 });
    expect(() => v1.encodeChord('(C7 F7)')).toThrow();
    expect(v2.symbols.slice(0, v1.size)).toEqual(v1.symbols);
    expect(v2.symbols.slice(v1.size)).toEqual([' ']);
    expect(() => buildChordVocabulary({ version: 3 })).toThrow();
  });
});
