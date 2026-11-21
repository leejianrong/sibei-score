import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { layout } from '@sibei/layout';
import { projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { renderScorePages } from '@sibei/ui';

/** `text.set` / `text.rm` (SIB2-169): text directions above the staff. */

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

const create: Operation = { type: 'score.create', payload: { id: 'chart', title: 'T', barCount: 4 } };
const set = (target: string, text: string): Operation => ({ type: 'text.set', target, payload: { text } });

describe('text.set', () => {
  it('puts a direction at a beat, and setting it again edits it in place', () => {
    const first = run([create, set('bar4.beat1', '(unis.)')]);
    const note = first.score.bars[3]!.annotations[0]!;
    expect(note).toMatchObject({ text: '(unis.)', onset: 0, id: 'annotation-1' });
    expect(note.review.flagged).toBe(false);

    const again = run([...first.log, set('bar4.beat1', 'solo on form')]);
    expect(again.score.bars[3]!.annotations).toHaveLength(1);
    expect(again.score.bars[3]!.annotations[0]).toMatchObject({ id: 'annotation-1', text: 'solo on form' });
    expect(replay(again.log)).toEqual(again.score);
  });

  it('refuses empty text and a bar that is not there', () => {
    const base = run([create]).score;
    expect(() => applyOperation(base, set('bar1.beat1', '  '))).toThrow(OperationError);
    expect(() => applyOperation(base, set('bar9.beat1', 'x'))).toThrow();
  });
});

describe('text.rm', () => {
  it('removes by beat or by the id the projection prints', () => {
    const two = run([create, set('bar1.beat1', 'a'), set('bar2.beat3', 'b')]);
    const byBeat = run([...two.log, { type: 'text.rm', target: 'bar1.beat1' }]);
    expect(byBeat.score.bars[0]!.annotations).toEqual([]);
    expect(byBeat.score.bars[1]!.annotations).toHaveLength(1);
    const byId = run([...two.log, { type: 'text.rm', target: 'annotation-2' }]);
    expect(byId.score.bars[1]!.annotations).toEqual([]);
  });

  it('says so when there is nothing there', () => {
    const base = run([create]).score;
    expect(() => applyOperation(base, { type: 'text.rm', target: 'bar1.beat1' })).toThrow(/no text direction/);
  });
});

describe('a text direction elsewhere', () => {
  const chart = (): Score =>
    run([
      create,
      set('bar2.beat3', '(unis.)'),
      { type: 'chord.set', target: 'bar2.beat3', payload: { text: 'Cmaj7' } },
    ]).score;

  it('is in the text projection with its beat and id', () => {
    expect(projectScore(chart())).toContain('bar2   text  beat3 "(unis.)" annotation-1');
  });

  it('is drawn above the staff, identically in the browser and on the server', () => {
    const score = chart();
    const svg = renderScoreToSvg(score)[0]!.svg;
    expect(svg).toContain('se-annotation');
    expect(svg).toContain('(unis.)');
    expect(renderScorePages(score).map((p) => p.svg)).toEqual(renderScoreToSvg(score).map((p) => p.svg));
    const items = layout(score).pages[0]!.systems[0]!.bars[1]!.items.filter((i) => i.kind === 'annotation');
    expect(items).toHaveLength(1);
  });

  it('round-trips through MusicXML <words>, keeping the beat', () => {
    const xml = scoreToMusicXml(chart());
    expect(xml).toContain('<words>(unis.)</words>');
    const back = musicXmlToScore(xml).score;
    expect(back.bars[1]!.annotations.map((a) => [a.text, a.onset])).toEqual([
      ['(unis.)', chart().bars[1]!.annotations[0]!.onset],
    ]);
  });
});
