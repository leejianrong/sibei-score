import { resolveBarAccidentals } from '@sibei/layout';
import type { Bar, KeySignature, Note } from '@sibei/model';
import { createIdFactory, dur, keySignatureAccidentals, makeBar, makeNote } from '@sibei/model';
import { describe, expect, it } from 'vitest';

/**
 * Which accidental is drawn is notation logic, so it is resolved in layout rather than
 * in the draw adapter (ADR-0014 leaves VexFlow the stacking, not the choosing).
 */

const E_FLAT_MAJOR: KeySignature = { tonic: 'E', alter: -1, mode: 'major' };
const C_MAJOR: KeySignature = { tonic: 'C', alter: 0, mode: 'major' };

interface NoteSpec {
  pitch: string;
  accidental?: Note['accidental'];
  tie?: Note['tie'];
}

function bar(specs: (string | NoteSpec)[]): Bar {
  const ids = createIdFactory();
  const items = specs.map((entry, index) => {
    const spec: NoteSpec = typeof entry === 'string' ? { pitch: entry } : entry;
    return makeNote({
      id: ids.next('note'),
      onset: index * 480,
      duration: dur(4),
      pitch: spec.pitch,
      ...(spec.accidental === undefined ? {} : { accidental: spec.accidental }),
      ...(spec.tie === undefined ? {} : { tie: spec.tie }),
    });
  });
  return makeBar({ id: 'bar-1', number: 1, items });
}

function glyphs(b: Bar, key: KeySignature): (number | null)[] {
  return [...resolveBarAccidentals(b, key).values()];
}

describe('key signatures', () => {
  it('name the steps they alter', () => {
    expect([...keySignatureAccidentals(E_FLAT_MAJOR).keys()]).toEqual(['B', 'E', 'A']);
    expect([...keySignatureAccidentals(C_MAJOR).keys()]).toEqual([]);
    expect([...keySignatureAccidentals({ tonic: 'F', alter: 1, mode: 'major' }).keys()]).toEqual([
      'F',
      'C',
      'G',
      'D',
      'A',
      'E',
    ]);
  });
});

describe('automatic accidentals', () => {
  it('draws nothing for notes the key signature already covers', () => {
    expect(glyphs(bar(['Eb5', 'Bb4', 'Ab4']), E_FLAT_MAJOR)).toEqual([null, null, null]);
  });

  it('draws a natural where the key signature flattens the step', () => {
    expect(glyphs(bar(['A4']), E_FLAT_MAJOR)).toEqual([0]);
    expect(glyphs(bar(['E5']), E_FLAT_MAJOR)).toEqual([0]);
  });

  it('draws a sharp for a step outside the key', () => {
    expect(glyphs(bar(['F#5']), E_FLAT_MAJOR)).toEqual([1]);
  });

  it('does not repeat itself later in the same bar', () => {
    expect(glyphs(bar(['F#5', 'G5', 'F#5']), E_FLAT_MAJOR)).toEqual([1, null, null]);
  });

  it('restores the key signature when a bar departs and returns', () => {
    // B natural cancels the key's Bb; the following Bb must say so again.
    expect(glyphs(bar(['B4', 'Bb4']), E_FLAT_MAJOR)).toEqual([0, -1]);
  });

  it('treats octaves separately', () => {
    expect(glyphs(bar(['F#5', 'F#4']), E_FLAT_MAJOR)).toEqual([1, 1]);
  });

  it('resets at the barline, because state is per bar', () => {
    const first = glyphs(bar(['F#5', 'F#5']), E_FLAT_MAJOR);
    const second = glyphs(bar(['F#5']), E_FLAT_MAJOR);
    expect(first).toEqual([1, null]);
    expect(second).toEqual([1]);
  });
});

describe('ties', () => {
  it('do not repeat the accidental on the far end', () => {
    expect(glyphs(bar([{ pitch: 'F#5', tie: 'stop' }]), E_FLAT_MAJOR)).toEqual([null]);
  });
});

describe('explicit overrides', () => {
  it('force an accidental that would otherwise be implied', () => {
    expect(glyphs(bar([{ pitch: 'Eb5', accidental: 'show' }]), E_FLAT_MAJOR)).toEqual([-1]);
  });

  it('suppress one that would otherwise be drawn', () => {
    expect(glyphs(bar([{ pitch: 'F#5', accidental: 'hide' }]), E_FLAT_MAJOR)).toEqual([null]);
  });
});
