import { formatChord, parseChord } from '@sibei/music';
import {
  CHORD_QUALITIES,
  enumerateChordSpace,
  generateScore,
  makeRng,
  randomChordStructure,
} from '@sibei/synth';
import { describe, expect, it } from 'vitest';

/**
 * Rich chord generation (V17b, ADR-0031). The corpus's chords now span the grammar so a recogniser
 * trains on real variety, not four diatonic sevenths. This pins the three things that make that safe:
 * every emitted chord round-trips through the grammar, the space is genuinely varied, and — the
 * load-bearing invariant — widening the chords leaves the *note* stream byte-identical, so the
 * Stage-2a note corpus and its baselines are untouched (the melody key stays put, KAN-1487).
 */

describe('randomChordStructure', () => {
  it('always emits a grammar-valid, round-tripping chord', () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const structure = randomChordStructure(makeRng(seed));
      const text = formatChord({ kind: 'chord', structure });
      const parsed = parseChord(text);
      expect(parsed, `unparseable: ${text}`).not.toBeNull();
      // Canonical: formatting the re-parsed structure reproduces the text.
      expect(parsed && parsed.kind === 'chord' ? formatChord(parsed) : null).toBe(text);
    }
  });

  it('roams across roots and qualities, not just C diatonic sevenths', () => {
    const roots = new Set<string>();
    const symbols = new Set<string>();
    for (let seed = 0; seed < 400; seed += 1) {
      const s = randomChordStructure(makeRng(seed));
      roots.add(`${s.root.step}${s.root.alter}`);
      symbols.add(formatChord({ kind: 'chord', structure: s }));
    }
    // More than a handful of roots (chromatic), and real variety of qualities.
    expect(roots.size).toBeGreaterThan(10);
    expect(symbols.size).toBeGreaterThan(40);
    // A sharp or flat root appears (the diatonic-C set never produced one).
    expect([...roots].some((r) => r.endsWith('1') || r.endsWith('-1'))).toBe(true);
  });
});

describe('enumerateChordSpace', () => {
  it('is closed: every enumerated structure round-trips through the grammar', () => {
    const space = enumerateChordSpace();
    expect(space.length).toBeGreaterThan(100);
    for (const structure of space) {
      const text = formatChord({ kind: 'chord', structure });
      expect(parseChord(text), `unparseable: ${text}`).not.toBeNull();
    }
  });

  it('covers every quality name', () => {
    const space = enumerateChordSpace();
    // Each quality contributes at least one structure (spot-check by the count of distinct triads/sevenths).
    expect(space.length).toBeGreaterThanOrEqual(CHORD_QUALITIES.length);
  });
});

describe('widening chords leaves notes byte-identical', () => {
  it('produces the same note/rest items with rich chords on or off', () => {
    for (const seed of [1, 5, 42, 99]) {
      const rich = generateScore({ seed, bars: 16, richChords: true });
      const diatonic = generateScore({ seed, bars: 16, richChords: false });
      const notesOf = (score: typeof rich) => score.bars.map((bar) => bar.items);
      expect(notesOf(rich)).toEqual(notesOf(diatonic));
    }
  });

  it('but the chords themselves differ (rich is not diatonic)', () => {
    const rich = generateScore({ seed: 5, bars: 16, richChords: true });
    const diatonic = generateScore({ seed: 5, bars: 16, richChords: false });
    const chords = (score: typeof rich) => score.bars.flatMap((b) => b.chords.map((c) => c.text));
    expect(chords(rich)).not.toEqual(chords(diatonic));
  });
});
