import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { layout } from '@sibei/layout';
import { projectScore, barViews } from '@sibei/model';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { renderScorePages } from '@sibei/ui';

/** A dashed continuation line after a text direction (SIB2-170). */

const create: Operation = { type: 'score.create', payload: { id: 'chart', title: 'T', barCount: 10 } };

function chart(until: string | null = 'bar7'): { score: Score; ops: Operation[] } {
  const ops: Operation[] = [create];
  let score = applyOperation(null, create).score;
  const text: Operation = { type: 'text.set', target: 'bar2.beat1', payload: { text: 'solo', until } };
  const applied = applyOperation(score, text);
  score = applied.score;
  ops.push(applied.operation);
  return { score, ops };
}

const svgOf = (score: Score): string => renderScoreToSvg(score).map((p) => p.svg).join('');

describe('text set --until', () => {
  it('stores the end bar by id, shows it, replays, keeps it on re-set and clears it with null', () => {
    const { score, ops } = chart();
    const annotation = barViews(score)[1]!.annotations[0]!;
    expect(annotation.lineEndBarId).toBe(score.bars[6]!.id);
    expect(projectScore(score)).toContain('"solo" ---> bar7');
    expect(replay(ops)).toEqual(score);
    const kept = applyOperation(score, { type: 'text.set', target: 'bar2.beat1', payload: { text: 'solo!' } });
    expect(barViews(kept.score)[1]!.annotations[0]!.lineEndBarId).toBe(barViews(score)[6]!.id);
    const cleared = applyOperation(score, { type: 'text.set', target: 'bar2.beat1', payload: { text: 'solo', until: null } });
    expect('lineEndBarId' in barViews(cleared.score)[1]!.annotations[0]!).toBe(false);
  });

  it('refuses an end bar before the direction', () => {
    const { score } = chart(null);
    expect(() =>
      applyOperation(score, { type: 'text.set', target: 'bar2.beat1', payload: { text: 'solo', until: 'bar1' } }),
    ).toThrow(OperationError);
  });

  it('lets the end bar go: removing it clears the line instead of dangling', () => {
    const { score } = chart('bar10');
    const removed = applyOperation(score, { type: 'bar.rm', target: 'bar10' });
    expect('lineEndBarId' in barViews(removed.score)[1]!.annotations[0]!).toBe(false);
  });

  it('draws segments across the bars it covers, closing with one hook, and a wrapped line continues', () => {
    const { score } = chart('bar7');
    const items = layout(score).pages.flatMap((p) => p.systems.flatMap((s) => s.bars.flatMap((b) => b.items)));
    expect(items.filter((i) => i.kind === 'directionLine')).toHaveLength(5);
    const svg = svgOf(score);
    // bar 2 (the text's own bar) + bars 3 to 7 each draw a dashed segment; only bar 7 closes with a hook.
    expect(svg.match(/se-directionline/g)).toHaveLength(6);
    expect(svg.match(/se-directionhook/g)).toHaveLength(1);
    // Bar 5 starts the second line (four bars to a system), so the line carries over a system break.
    const second = layout(score).pages[0]!.systems[1]!;
    expect(second.bars[0]!.items.some((i) => i.kind === 'directionLine')).toBe(true);
    expect(svgOf(chart(null).score)).not.toContain('se-directionline');
  });

  it('draws the same bytes in the browser and on the server', () => {
    const { score } = chart();
    expect(renderScorePages(score).map((p) => p.svg)).toEqual(renderScoreToSvg(score).map((p) => p.svg));
  });

  it('round-trips through MusicXML dashes', () => {
    const { score } = chart();
    const xml = scoreToMusicXml(score);
    expect(xml).toContain('<dashes type="start"');
    expect(xml).toContain('<dashes type="stop"');
    const back = musicXmlToScore(xml).score;
    const annotation = barViews(back)[1]!.annotations[0]!;
    expect(back.bars.find((b) => b.id === annotation.lineEndBarId)?.number).toBe(7);
  });
});
