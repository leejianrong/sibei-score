import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { layout, writtenPitch } from '@sibei/layout';
import { projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { renderScorePages } from '@sibei/ui';
import { ottavaOp, ottavasOnNote } from '../../packages/ui/src/lib/slur-edits.js';

/** Ottava lines, 8va and 8vb (SIB2-184): a spanner of kind `ottava`, drawn shifted, never stored shifted. */

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

const create: Operation = { type: 'score.create', payload: { id: 'chart', title: 'T', barCount: 3 } };
const note = (target: string, pitch: string): Operation => ({
  type: 'note.add',
  target,
  payload: { pitch, duration: { value: 4, dots: 0 } },
});
const melody: Operation[] = [
  create,
  note('bar1.beat1', 'C5'),
  note('bar1.beat2', 'D5'),
  note('bar1.beat3', 'E5'),
  note('bar2.beat1', 'F5'),
  note('bar2.beat2', 'G5'),
];
const ottava = (target: string, to: string, shift: 'up' | 'down' = 'up'): Operation => ({
  type: 'ottava.set',
  target,
  payload: { to, shift },
});

describe('ottava.set / ottava.rm', () => {
  it('stores a spanner between two notes, keeps the sounding pitches, and replays', () => {
    const { score, log } = run([...melody, ottava('bar1.n2', 'bar2.n1')]);
    expect(score.spanners).toEqual([
      { id: 'ottava-1', kind: 'ottava', startId: 'note-2', endId: 'note-4', octaveShift: 'up' },
    ]);
    expect(score.bars[0]!.items.map((i) => (i.kind === 'note' ? i.pitch.octave : 0))).toEqual([5, 5, 5]);
    expect(replay(log)).toEqual(score);
    expect(projectScore(score)).toContain('ottava  bar1.n2 -> bar2.n1 8va ottava-1');
  });

  it('is an upsert on the same pair, removes by id or by start note, and refuses bad input', () => {
    const base = run([...melody, ottava('bar1.n2', 'bar2.n1')]).score;
    const flipped = applyOperation(base, ottava('bar1.n2', 'bar2.n1', 'down')).score;
    expect(flipped.spanners).toHaveLength(1);
    expect(flipped.spanners![0]!.octaveShift).toBe('down');
    expect(projectScore(flipped)).toContain('8vb');
    expect(applyOperation(base, { type: 'ottava.rm', target: 'ottava-1' }).score.spanners).toBeUndefined();
    expect(applyOperation(base, { type: 'ottava.rm', target: 'bar1.n2' }).score.spanners).toBeUndefined();
    const bad = (op: Operation): void => expect(() => applyOperation(base, op)).toThrow(OperationError);
    bad(ottava('bar2.n1', 'bar1.n2'));
    bad(ottava('bar1.n1', 'bar1.n1'));
    bad({ type: 'ottava.set', target: 'bar1.n1', payload: { to: 'bar1.n2', shift: 'sideways' as never } });
    bad(ottava('bar1.n3', 'bar2.n2')); // overlaps the existing line
    bad({ type: 'ottava.rm', target: 'bar1.n1' });
  });

  it('goes away with a note it ends on', () => {
    const base = run([...melody, ottava('bar1.n2', 'bar2.n1')]).score;
    const gone = applyOperation(base, { type: 'note.rm', target: 'bar2.n1' }).score;
    expect(gone.spanners).toBeUndefined();
  });
});

describe('ottava layout and drawing', () => {
  const marked = run([...melody, ottava('bar1.n2', 'bar2.n1')]).score;
  const plain = run(melody).score;

  it('draws notes shifted: written an octave lower under 8va, but only inside the run', () => {
    const items = layout(marked).pages[0]!.systems[0]!.bars.flatMap((b) => b.items).filter((i) => i.kind === 'note');
    expect(items.map((i) => i.ottava)).toEqual([undefined, 'up', 'up', 'up', undefined]);
    expect(writtenPitch(items[1]!.pitch, 'up').octave).toBe(items[1]!.pitch.octave - 1);
    expect(writtenPitch(items[1]!.pitch, 'down').octave).toBe(items[1]!.pitch.octave + 1);
    // The staff position moved, so the notehead sits lower on the page than the unmarked render's.
    const svg = renderScoreToSvg(marked).map((p) => p.svg).join('');
    expect(svg).not.toBe(renderScoreToSvg(plain).map((p) => p.svg).join(''));
  });

  it('draws one label, one dashed line and one hook, and nothing on an unmarked chart', () => {
    const svg = renderScoreToSvg(marked).map((p) => p.svg).join('');
    expect(svg.match(/se-ottava"/g)).toHaveLength(1);
    expect(svg.match(/se-ottavaline/g)).toHaveLength(1);
    expect(svg.match(/se-ottavahook/g)).toHaveLength(1);
    expect(svg).toContain('>8va<');
    expect(renderScoreToSvg(plain).map((p) => p.svg).join('')).not.toContain('se-ottava');
  });

  it('draws 8vb below the staff', () => {
    const below = applyOperation(marked, ottava('bar1.n2', 'bar2.n1', 'down')).score;
    expect(renderScoreToSvg(below).map((p) => p.svg).join('')).toContain('>8vb<');
    expect(layout(below).pages[0]!.systems[0]!.ottavaBelowOffset).toBeGreaterThan(0);
    expect(layout(below).pages[0]!.systems[0]!.ottavaAboveOffset).toBeUndefined();
  });

  it('gives the browser the same bytes as the server', () => {
    expect(renderScorePages(marked).map((p) => p.svg)).toEqual(renderScoreToSvg(marked).map((p) => p.svg));
  });

  it('continues a line across a system break', () => {
    const long = run([
      { type: 'score.create', payload: { id: 'c', title: 'T', barCount: 8 } },
      note('bar1.beat1', 'C5'),
      note('bar6.beat1', 'D5'),
      ottava('bar1.n1', 'bar6.n1'),
    ]).score;
    const systems = layout(long).pages[0]!.systems;
    expect(systems[0]!.ottavas[0]).toMatchObject({ fromNoteId: 'note-1', toNoteId: null, labelled: true });
    expect(systems[1]!.ottavas[0]).toMatchObject({ fromNoteId: null, toNoteId: 'note-2', labelled: false });
  });
});

describe('ottava in the browser edits and MusicXML', () => {
  const marked = run([...melody, ottava('bar1.n2', 'bar2.n1')]).score;

  it('builds the op from two clicked notes in either order, and lists lines on a note inside the run', () => {
    expect(ottavaOp(marked, 'note-4', 'note-2', 'down')).toEqual({
      type: 'ottava.set',
      target: 'note-2',
      payload: { to: 'note-4', shift: 'down' },
    });
    expect(ottavaOp(marked, 'note-2', 'note-2', 'up')).toBeNull();
    expect(ottavasOnNote(marked, 'note-3').map((s) => s.id)).toEqual(['ottava-1']);
    expect(ottavasOnNote(marked, 'note-1')).toEqual([]);
  });

  it('round-trips through <octave-shift> (MusicXML down is our 8va)', () => {
    const xml = scoreToMusicXml(marked);
    expect(xml).toContain('<octave-shift type="down" size="8" number="1"/>');
    expect(xml).toContain('<octave-shift type="stop" size="8" number="1"/>');
    const back = musicXmlToScore(xml).score;
    const line = back.spanners!.find((s) => s.kind === 'ottava')!;
    expect(line.octaveShift).toBe('up');
    const first = back.bars[0]!.items.filter((i) => i.kind === 'note');
    expect(line.startId).toBe(first[1]!.id);
    expect(back.bars[0]!.items.map((i) => (i.kind === 'note' ? i.pitch.octave : 0))).toEqual([5, 5, 5]);
  });
});
