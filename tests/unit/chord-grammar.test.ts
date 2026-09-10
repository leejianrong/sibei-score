import { formatChord, parseChord } from '@sibei/music';
import type { Chord, ChordStructure } from '@sibei/music';
import { describe, expect, it } from 'vitest';

/**
 * The chord grammar (ADR-0012). This suite is doing double duty: it is V5's acceptance test for
 * what a user or agent may type, and it is the living list of real-world spellings that ADR-0011's
 * OCR corrector will lean on. So it is deliberately long — every spelling that shows up on a real
 * chart is a row here, and a bug found later becomes a new row before it is fixed.
 */

/** Sugar: the structure of a chord that must parse, failing loudly if it did not. */
function structure(text: string): ChordStructure {
  const chord = parseChord(text);
  expect(chord, `expected ${JSON.stringify(text)} to parse`).not.toBeNull();
  expect((chord as Chord).kind).toBe('chord');
  return (chord as { kind: 'chord'; structure: ChordStructure }).structure;
}

describe('parsing the required jazz vocabulary (ADR-0012)', () => {
  it('C is a bare major triad', () => {
    const s = structure('C');
    expect(s.root).toEqual({ step: 'C', alter: 0 });
    expect(s.triad).toBe('major');
    expect(s.seventh).toBeNull();
    expect(s.bass).toBeNull();
  });

  it('Cmaj7 is a major triad with a major seventh', () => {
    const s = structure('Cmaj7');
    expect(s.triad).toBe('major');
    expect(s.seventh).toBe('major');
    expect(s.extension).toBeNull();
  });

  it('Cm7 is a minor triad with a flat seventh', () => {
    const s = structure('Cm7');
    expect(s.triad).toBe('minor');
    expect(s.seventh).toBe('minor');
  });

  it('F#m7b5 is a half-diminished chord', () => {
    const s = structure('F#m7b5');
    expect(s.root).toEqual({ step: 'F', alter: 1 });
    expect(s.triad).toBe('minor');
    expect(s.seventh).toBe('minor');
    expect(s.alterations).toEqual([{ degree: 5, alter: -1 }]);
  });

  it('C7alt is a dominant with the alterations left open', () => {
    const s = structure('C7alt');
    expect(s.triad).toBe('major');
    expect(s.seventh).toBe('minor');
    expect(s.alt).toBe(true);
  });

  it('Bb13#11 stacks to the thirteenth with a sharp eleventh', () => {
    const s = structure('Bb13#11');
    expect(s.root).toEqual({ step: 'B', alter: -1 });
    expect(s.seventh).toBe('minor');
    expect(s.extension).toBe(13);
    expect(s.alterations).toEqual([{ degree: 11, alter: 1 }]);
  });

  it('Ab/Eb is a triad over a slash bass', () => {
    const s = structure('Ab/Eb');
    expect(s.root).toEqual({ step: 'A', alter: -1 });
    expect(s.triad).toBe('major');
    expect(s.seventh).toBeNull();
    expect(s.bass).toEqual({ step: 'E', alter: -1 });
  });

  it('N.C. is a no-chord marking, not a failure to parse', () => {
    expect(parseChord('N.C.')).toEqual({ kind: 'no-chord' });
    expect(parseChord('NC')).toEqual({ kind: 'no-chord' });
    expect(parseChord('n.c.')).toEqual({ kind: 'no-chord' });
  });
});

describe('the long tail of real spellings folds onto one structure', () => {
  const groups: Record<string, string[]> = {
    // Every spelling in a row must parse to the same structure as the row's first (canonical) entry.
    'Cmaj7': ['CM7', 'Cma7', 'CΔ7', 'CΔ', 'Cmajor7'],
    'Cm7': ['C-7', 'Cmin7', 'Cmi7'],
    'Cm': ['C-', 'Cmin', 'Cmi'],
    'Cdim7': ['Co7', 'C°7'],
    'Cdim': ['Co', 'C°'],
    'Cm7b5': ['Cø', 'Cø7', 'Cmi7b5', 'Cm7♭5', 'C-7b5'],
    'Caug': ['C+'],
    'C7#5': ['C7+5'],
    'C7b9': ['C7-9'],
    'Csus4': ['Csus'],
  };

  for (const [canonical, spellings] of Object.entries(groups)) {
    it(`${canonical} absorbs ${spellings.join(', ')}`, () => {
      const target = structure(canonical);
      for (const spelling of spellings) {
        expect(structure(spelling), `${spelling} should read as ${canonical}`).toEqual(target);
      }
    });
  }
});

describe('formatting round-trips every canonical spelling back to itself', () => {
  const canonical = [
    'C',
    'Cm',
    'Cdim',
    'Caug',
    'C7',
    'Cmaj7',
    'Cm7',
    'Cm7b5',
    'Cdim7',
    'CmMaj7',
    'C6',
    'Cm6',
    'C6/9',
    'C9',
    'Cmaj9',
    'Cm9',
    'C11',
    'C13',
    'Bb13#11',
    'C7b9',
    'C7#9',
    'C7#11',
    'C7b13',
    'C7#5',
    'C7b5',
    'C7alt',
    'Csus2',
    'Csus4',
    'C7sus4',
    'Cadd9',
    'C5',
    'Ab/Eb',
    'F#m7b5',
    'Dbmaj7/F',
    'N.C.',
  ];

  for (const text of canonical) {
    it(`${text} is its own canonical form`, () => {
      const parsed = parseChord(text);
      expect(parsed, `${text} should parse`).not.toBeNull();
      expect(formatChord(parsed as Chord)).toBe(text);
    });
  }

  it('re-parsing a formatted variant is idempotent', () => {
    for (const variant of ['CM7', 'C-7', 'Cø', 'C+', 'Cma9', 'C7-5']) {
      const once = parseChord(variant);
      expect(once).not.toBeNull();
      const canonicalText = formatChord(once as Chord);
      expect(parseChord(canonicalText)).toEqual(once);
    }
  });
});

describe('unparseable text is rejected, not half-understood (ADR-0012)', () => {
  for (const text of ['', '   ', 'solo break', 'H7', 'wat', 'C7xyz', '/G', '???', 'Cmaj7!!']) {
    it(`${JSON.stringify(text)} does not parse`, () => {
      expect(parseChord(text)).toBeNull();
    });
  }
});
