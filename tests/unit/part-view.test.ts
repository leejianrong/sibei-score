import { describe, expect, it } from 'vitest';
import { PART_INSTRUMENTS, applyOperation, writtenPart } from '@sibei/api';
import type { Operation, PartInstrument } from '@sibei/api';
import { formatKeySignature, formatPitch, pitchToMidi } from '@sibei/model';
import type { Note, Score } from '@sibei/model';

/**
 * `writtenPart` — instrument parts as a pure render-time view (V6c, ADR-0016). The score always
 * stores concert pitch; this is the transform the export path runs just before rendering, and never
 * persists. The properties worth pinning per instrument are the three a player checks: the written
 * interval, the written *octave* (the one most easily got wrong), and the key signature.
 */

function chart(notes: { target: string; pitch: string; pinned?: boolean }[], chords: { target: string; text: string }[]): Score {
  let score: Score | null = null;
  const apply = (operation: Operation): void => {
    score = applyOperation(score, operation).score;
  };
  apply({ type: 'score.create', payload: { id: 'c', barCount: 4, key: { tonic: 'C', alter: 0, mode: 'major' } } });
  for (const n of notes) {
    apply({ type: 'note.add', target: n.target, payload: { pitch: n.pitch, duration: { value: 4, dots: 0 }, ...(n.pinned ? { spellingPinned: true } : {}) } });
  }
  for (const c of chords) apply({ type: 'chord.set', target: c.target, payload: { text: c.text } });
  if (score === null) throw new Error('empty');
  return score;
}

const firstNote = (score: Score): Note => {
  const item = score.bars[0]?.items[0];
  if (item === undefined || item.kind !== 'note') throw new Error('no note');
  return item;
};

/** A concert middle-C chart with a C major chord, one per instrument to read the written pitch off. */
const middleC = (): Score => chart([{ target: 'bar1.beat1', pitch: 'C4' }], [{ target: 'bar1.beat1', text: 'C7' }]);

describe('each instrument writes at the right interval, octave and key (ADR-0016)', () => {
  const cases: { instrument: Exclude<PartInstrument, 'concert'>; pitch: string; key: string; semitonesUp: number }[] = [
    { instrument: 'bb-trumpet', pitch: 'D4', key: 'D', semitonesUp: 2 }, // M2
    { instrument: 'bb-tenor', pitch: 'D5', key: 'D', semitonesUp: 14 }, // M9 — same key as the trumpet, an octave up
    { instrument: 'eb-alto', pitch: 'A4', key: 'A', semitonesUp: 9 }, // M6
    { instrument: 'eb-bari', pitch: 'A5', key: 'A', semitonesUp: 21 }, // M13 — an octave above the alto
    { instrument: 'f-horn', pitch: 'G4', key: 'G', semitonesUp: 7 }, // P5
  ];

  for (const c of cases) {
    it(`${c.instrument}: concert C4 is written ${c.pitch} in ${c.key}`, () => {
      const part = writtenPart(middleC(), c.instrument);
      const note = firstNote(part);
      expect(formatPitch(note.pitch)).toBe(c.pitch);
      expect(formatKeySignature(part.meta.key)).toBe(c.key);
      // The interval is exactly what the label claims, octave included.
      expect(pitchToMidi(note.pitch) - pitchToMidi({ step: 'C', alter: 0, octave: 4 })).toBe(c.semitonesUp);
      // The chord root moves by the same interval, respelled in the written key.
      expect(part.bars[0]?.chords[0]?.text).toBe(`${c.key}7`);
    });
  }
});

describe('the concert score is the identity', () => {
  it('returns the score unchanged for concert', () => {
    const score = middleC();
    expect(writtenPart(score, 'concert')).toEqual(score);
  });

  it('covers every declared instrument', () => {
    // Guards the guard: a new instrument in PART_INSTRUMENTS must get a written pitch here.
    expect(PART_INSTRUMENTS).toEqual(['concert', 'bb-trumpet', 'bb-tenor', 'eb-alto', 'eb-bari', 'f-horn']);
  });
});

describe('parts respect the same spelling rules as transposition (ADR-0017)', () => {
  it('respells the melody by the written key signature, not the concert one', () => {
    // Concert Bb4 (a written-flat pitch) on an Eb-alto part is a major sixth up = G5, spelled in A.
    const score = chart([{ target: 'bar1.beat1', pitch: 'Bb4' }], []);
    const part = writtenPart(score, 'eb-alto');
    expect(formatPitch(firstNote(part).pitch)).toBe('G5');
    expect(formatKeySignature(part.meta.key)).toBe('A');
  });

  it('honours a note pin across the part transform', () => {
    // A pinned G#4 written for F horn (P5 up) rides the interval to D#5, where the written key (G)
    // left to itself would not have chosen the sharp for that pitch class.
    const score = chart([{ target: 'bar1.beat1', pitch: 'G#4', pinned: true }], []);
    const part = writtenPart(score, 'f-horn');
    expect(formatPitch(firstNote(part).pitch)).toBe('D#5');
  });

  it('does not touch the stored score', () => {
    const score = middleC();
    const snapshot = structuredClone(score);
    writtenPart(score, 'bb-tenor');
    expect(score).toEqual(snapshot);
  });
});
