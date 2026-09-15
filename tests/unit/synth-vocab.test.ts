import type { KeySignature } from '@sibei/model';
import {
  BLANK_SYMBOL,
  buildVocabulary,
  extractLabels,
  generateScore,
  itemSequence,
  tokenSymbol,
} from '@sibei/synth';
import { describe, expect, it } from 'vitest';

/**
 * The flat-semantic vocabulary is the manifest training and eval both read (V15a, ADR-0031), so it
 * has to be deterministic, have the CTC blank pinned at id 0, and — the load-bearing property —
 * cover **every** token the generator can emit, since it is derived from the same ladder. If a
 * generated corpus produced a token with no class, training labels would silently break.
 */

const D_MAJOR: KeySignature = { tonic: 'D', alter: 0, mode: 'major' };

describe('buildVocabulary', () => {
  it('is deterministic and pins the blank at id 0', () => {
    const a = buildVocabulary();
    const b = buildVocabulary();
    expect(a.symbols).toEqual(b.symbols);
    expect(a.symbols[0]).toBe(BLANK_SYMBOL);
    expect(a.idOfSymbol(BLANK_SYMBOL)).toBe(0);
  });

  it('has a modest, closed size for the probe (C major)', () => {
    const vocab = buildVocabulary();
    // 15 ladder pitches x 5 durations = 75 notes, + 5 rests, + 1 blank = 81.
    expect(vocab.size).toBe(81);
    expect(vocab.symbols.length).toBe(vocab.size);
  });

  it('gives every symbol a unique, contiguous id', () => {
    const vocab = buildVocabulary();
    const ids = vocab.symbols.map((s) => vocab.idOfSymbol(s));
    expect(ids).toEqual(vocab.symbols.map((_, i) => i));
    expect(new Set(vocab.symbols).size).toBe(vocab.symbols.length);
  });

  it('covers every token a C-major corpus emits, across many seeds', () => {
    const vocab = buildVocabulary();
    for (let seed = 0; seed < 60; seed += 1) {
      const labels = extractLabels(generateScore({ seed, bars: 16 }));
      for (const token of itemSequence(labels)) {
        // idOf throws if the token is out of vocabulary; that is the failure we are guarding.
        expect(() => vocab.idOf(token)).not.toThrow();
        expect(vocab.symbols[vocab.idOf(token)]).toBe(tokenSymbol(token));
      }
    }
  });

  it('covers other keys when asked, and rejects their tokens otherwise', () => {
    const cMajorOnly = buildVocabulary();
    const withD = buildVocabulary({ keys: [{ tonic: 'C', alter: 0, mode: 'major' }, D_MAJOR] });
    // D major introduces F# and C#, which C-major-only cannot spell.
    const labels = extractLabels(generateScore({ seed: 7, bars: 16, key: D_MAJOR }));
    let sawSharp = false;
    for (const token of itemSequence(labels)) {
      expect(() => withD.idOf(token)).not.toThrow();
      if (token.kind === 'note' && token.alter !== 0) {
        sawSharp = true;
        expect(cMajorOnly.idOfSymbol(tokenSymbol(token))).toBeUndefined();
      }
    }
    expect(sawSharp).toBe(true); // the test is only meaningful if D major actually altered a pitch
    expect(withD.size).toBeGreaterThan(cMajorOnly.size);
  });

  it('names notes and rests the way training reads them', () => {
    const vocab = buildVocabulary();
    expect(tokenSymbol({ kind: 'note', step: 'C', alter: 0, octave: 4, value: 4, dots: 0 })).toBe('note_C4_4');
    expect(tokenSymbol({ kind: 'note', step: 'F', alter: 1, octave: 5, value: 4, dots: 1 })).toBe('note_F#5_4d');
    expect(tokenSymbol({ kind: 'rest', value: 2, dots: 0 })).toBe('rest_2');
    expect(vocab.idOfSymbol('note_C4_4')).toBeGreaterThan(0);
  });
});
