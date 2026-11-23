import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { barMetrics, barViews, chordTones, parseAddress, projectScore, resolveAddress } from '@sibei/model';
import type { Note, Score } from '@sibei/model';
import { writtenPart } from '@sibei/music';

/** Stacked chords (SIB2-243, ADR-0041 "As built: stacked chords"): the model, the ops, addressing and the projection. */

function run(operations: Operation[]): { score: Score; log: Operation[] } {
  const log: Operation[] = [];
  let score: Score | null = null;
  for (const operation of operations) {
    const applied = applyOperation(score, operation);
    score = applied.score;
    log.push(applied.operation);
  }
  if (score === null) throw new Error('no score');
  return { score, log };
}

const q = { value: 4, dots: 0 } as const;
const base: Operation[] = [
  { type: 'score.create', payload: { id: 'chart', barCount: 2 } },
  { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'C4', duration: q } },
  { type: 'note.add', target: 'bar1.beat2', payload: { pitch: 'A4', duration: q } },
  { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'G4', duration: q } },
  { type: 'note.add', target: 'bar1.n1', payload: { pitch: 'E4', duration: q } },
];
const noteAt = (score: Score, at: number): Note => {
  const item = barViews(score)[0]?.items[at];
  if (item?.kind !== 'note') throw new Error('no note');
  return item;
};
const fails = (operations: Operation[], text: RegExp): void => {
  expect(() => run(operations)).toThrow(OperationError);
  try {
    run(operations);
  } catch (error) {
    expect((error as Error).message).toMatch(text);
  }
};

describe('note.add onto a held onset', () => {
  it('stacks a chord, counts it once in the bar, and replays to the same score', () => {
    const { score, log } = run(base);
    const chord = noteAt(score, 0);
    expect(chordTones(chord).map((t) => `${t.pitch.step}${t.pitch.octave}`)).toEqual(['C4', 'E4', 'G4']);
    expect(chord.stack?.map((t) => t.id)).toEqual(['note-3', 'note-4']);
    expect(barViews(score)[0]?.items).toHaveLength(2);
    expect(barMetrics(barViews(score)[0]!, score.meta.time).actual).toBe(960);
    expect(replay(log)).toEqual(score);
  });

  it('refuses a different duration, a repeated pitch, and articulations on one pitch', () => {
    fails([...base, { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'B4', duration: { value: 8, dots: 0 } } }], /share one duration/);
    fails([...base, { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'E4', duration: q } }], /already has E4/);
    fails([...base, { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'B4', duration: q, articulations: ['accent'] } }], /whole chord/);
  });

  it('still refuses a note onto a rest', () => {
    fails(
      [
        { type: 'score.create', payload: { id: 'c', barCount: 1 } },
        { type: 'rest.add', target: 'bar1.beat1', payload: { duration: q } },
        { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'C4', duration: q } },
      ],
      /already has a rest/,
    );
  });
});

describe('addressing one pitch', () => {
  it('names a pitch by suffix or by its id, strictly', () => {
    const { score } = run(base);
    expect(parseAddress('bar1.n1.e4')).toMatchObject({ form: 'ordinal', tone: 'E4' });
    expect(resolveAddress(score, 'bar1.n1.E4', 'note').tone?.id).toBe('note-4');
    expect(resolveAddress(score, 'note-3', 'note').tone?.id).toBe('note-3');
    expect(resolveAddress(score, 'bar1.n1.C4', 'note').tone?.primary).toBe(true);
    expect(() => resolveAddress(score, 'bar1.n1.D4', 'note')).toThrow(/pitches are C4, E4, G4/);
  });

  it('names a pitch at a beat too, which is how the browser addresses it', () => {
    const { score } = run(base);
    expect(parseAddress('s1.v1.bar1.beat1.E4')).toMatchObject({ form: 'beat', beat: 1, tone: 'E4' });
    expect(resolveAddress(score, 'bar1.beat1.E4', 'note').tone?.id).toBe('note-4');
    expect(() => resolveAddress(score, 'bar1.beat2.E4', 'note')).toThrow(/pitches are A4/);
    const removed = run([...base, { type: 'note.rm', target: 'bar1.beat1.G4' }]).score;
    expect(chordTones(noteAt(removed, 0)).map((t) => t.pitch.step)).toEqual(['C', 'E']);
  });

  it('removes one pitch, promoting the lowest when the carrying one goes, and the last pitch removes the note', () => {
    const { score, log } = run([...base, { type: 'note.rm', target: 'bar1.n1.E4' }]);
    expect(chordTones(noteAt(score, 0)).map((t) => t.pitch.step)).toEqual(['C', 'G']);
    const promoted = run([...base, { type: 'note.rm', target: 'bar1.n1.C4' }]).score;
    expect(noteAt(promoted, 0).id).toBe('note-1');
    expect(chordTones(noteAt(promoted, 0)).map((t) => t.pitch.step)).toEqual(['E', 'G']);
    expect(replay(log)).toEqual(score);
    const single = run([
      ...base,
      { type: 'note.rm', target: 'bar1.n1.E4' },
      { type: 'note.rm', target: 'bar1.n1.G4' },
      { type: 'note.rm', target: 'bar1.n1.C4' },
    ]).score;
    expect(barViews(single)[0]?.items.map((i) => i.id)).toEqual(['note-2']);
  });

  it('sets one pitch, sets the duration of all, and refuses a duration on one pitch', () => {
    const tied = run([...base, { type: 'note.set', target: 'bar1.n1.G4', payload: { tie: 'start' } }]).score;
    expect(noteAt(tied, 0).stack?.find((t) => t.id === 'note-3')?.tie).toBe('start');
    expect(noteAt(tied, 0).tie).toBe('none');
    const longer = run([...base, { type: 'note.set', target: 'bar1.n1', payload: { duration: { value: 2, dots: 0 } } }]).score;
    expect(noteAt(longer, 0).duration.value).toBe(2);
    fails([...base, { type: 'note.set', target: 'bar1.n1.E4', payload: { duration: { value: 2, dots: 0 } } }], /whole chord/);
    fails([...base, { type: 'note.set', target: 'bar1.n1.E4', payload: { pitch: 'G4' } }], /repeat G4/);
  });
});

describe('transposition and the projection', () => {
  it('moves every pitch, in the score and in a written part', () => {
    const { score } = run([...base, { type: 'transpose', payload: { to: { tonic: 'D', alter: 0, mode: 'major' } } }]);
    expect(chordTones(noteAt(score, 0)).map((t) => `${t.pitch.step}${t.pitch.alter === 1 ? '#' : ''}`)).toEqual(['D', 'F#', 'A']);
    const written = writtenPart(run(base).score, 'bb-trumpet');
    expect(chordTones(noteAt(written, 0))).toHaveLength(3);
  });

  it('prints a chord in brackets and leaves a single-note bar as it was', () => {
    const text = projectScore(run(base).score);
    expect(text).toContain('n1 [c4 e4 g4]/4');
    expect(text).toContain('n2 a4/4');
    expect(projectScore(run(base.slice(0, 3)).score)).toContain('n1 c4/4  n2 a4/4');
  });
});
