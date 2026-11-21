import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { marksChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';

/** Fermatas (SIB2-183): on a note or a rest, an op pair, a `^` in `show`, `<fermata>` in MusicXML. */

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

const base: Operation[] = [
  { type: 'score.create', payload: { id: 'chart', barCount: 2 } },
  { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'C5', duration: { value: 4, dots: 0 } } },
  { type: 'rest.add', target: 'bar1.beat2', payload: { duration: { value: 4, dots: 0 } } },
];

describe('fermata.set and fermata.rm', () => {
  it('puts a fermata on a note and on a rest, and takes it off again', () => {
    const on = run([...base, { type: 'fermata.set', target: 'bar1.n1' }, { type: 'fermata.set', target: 'bar1.n2' }]);
    expect(on.score.bars[0]!.items.map((item) => item.fermata)).toEqual([true, true]);
    expect(replay(on.log)).toEqual(on.score);

    const off = run([...on.log, { type: 'fermata.rm', target: 'bar1.n1' }]);
    // Absent, never `false`: an old document and a cleared one are the same shape.
    expect('fermata' in off.score.bars[0]!.items[0]!).toBe(false);
    expect(off.score.bars[0]!.items[1]!.fermata).toBe(true);
  });

  it('is idempotent to set, and refuses to remove what is not there', () => {
    const once = run([...base, { type: 'fermata.set', target: 'bar1.n1' }]);
    expect(run([...once.log, { type: 'fermata.set', target: 'bar1.n1' }]).score).toEqual(once.score);
    expect(() => applyOperation(once.score, { type: 'fermata.rm', target: 'bar1.n2' })).toThrow(OperationError);
    expect(() => applyOperation(once.score, { type: 'fermata.set', target: 'bar2.n1' })).toThrow();
  });

  it('survives note.set and a transpose', () => {
    const held = run([
      ...base,
      { type: 'fermata.set', target: 'bar1.n1' },
      { type: 'note.set', target: 'bar1.n1', payload: { pitch: 'D5' } },
      { type: 'transpose', payload: { to: { tonic: 'F', alter: 0, mode: 'major' } } },
    ]);
    expect(held.score.bars[0]!.items[0]!.fermata).toBe(true);
  });

  it('shows as ^ in the text projection', () => {
    const { score } = run([...base, { type: 'fermata.set', target: 'bar1.n1' }, { type: 'fermata.set', target: 'bar1.n2' }]);
    expect(projectScore(score)).toContain('n1 c5/4^  n2 r/4^');
  });
});

describe('fermata drawing and MusicXML', () => {
  it('draws one glyph per fermata, on both the note and the rest', () => {
    const svg = renderScoreToSvg(marksChart())
      .map((page) => page.svg)
      .join('');
    // Five fermatas in the fixture; the glyph is the one path with the dot below the arc.
    const items = layout(marksChart()).pages[0]!.systems[0]!.bars.flatMap((bar) => bar.items);
    expect(items.filter((item) => (item.kind === 'note' || item.kind === 'rest') && item.fermata === true)).toHaveLength(5);
    expect(svg.match(/se-fermataAbove/g)).toHaveLength(5);
  });

  it('round-trips through <fermata> on notes and rests', () => {
    const { score } = run([...base, { type: 'fermata.set', target: 'bar1.n1' }, { type: 'fermata.set', target: 'bar1.n2' }]);
    const xml = scoreToMusicXml(score);
    expect(xml.match(/<fermata type="upright"\/>/g)).toHaveLength(2);
    const back = musicXmlToScore(xml, { id: 'chart' });
    expect(back.score.bars[0]!.items.map((item) => item.fermata)).toEqual([true, true]);
    expect(back.warnings).toEqual([]);
  });
});
