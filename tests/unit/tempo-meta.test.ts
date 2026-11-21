import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { aabaChart } from '@sibei/fixtures';
import { projectScore } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { renderScorePages } from '@sibei/ui';

/** The tempo mark (SIB2-177): meta.set, the render, MusicXML and surface parity. */

const create: Operation = { type: 'score.create', payload: { id: 'chart', title: 'T', barCount: 4 } };
const tempo = { unit: { value: 4 as const, dots: 1 as const }, bpm: 92 };

describe('meta.set --tempo', () => {
  it('sets, projects, clears, replays and validates', () => {
    const a = applyOperation(null, create);
    const b = applyOperation(a.score, { type: 'meta.set', payload: { tempo } });
    expect(b.score.meta.tempo).toEqual(tempo);
    expect(projectScore(b.score)).toContain('tempo: 4.=92');
    expect(replay([a.operation, b.operation])).toEqual(b.score);
    const c = applyOperation(b.score, { type: 'meta.set', payload: { tempo: null } });
    expect('tempo' in c.score.meta).toBe(false);
    for (const bad of [
      { unit: { value: 3 }, bpm: 90 },
      { unit: { value: 4, dots: 2 }, bpm: 90 },
      { unit: { value: 4 }, bpm: 5 },
      { unit: { value: 4 }, bpm: 90.5 },
    ]) {
      expect(() => applyOperation(a.score, { type: 'meta.set', payload: { tempo: bad } })).toThrow(OperationError);
    }
  });

  it('draws a mark on the first bar only, and the browser draws the same bytes', () => {
    const plain = aabaChart();
    const marked = { ...plain, meta: { ...plain.meta, tempo } };
    const svg = renderScoreToSvg(marked).map((p) => p.svg);
    expect(svg.join('').match(/se-tempo/g)).toHaveLength(1);
    expect(renderScoreToSvg(plain).map((p) => p.svg).join('')).not.toContain('se-tempo');
    expect(renderScorePages(marked).map((p) => p.svg)).toEqual(svg);
  });

  it('round-trips through MusicXML with a quarter-note <sound tempo>', () => {
    const plain = aabaChart();
    const xml = scoreToMusicXml({ ...plain, meta: { ...plain.meta, tempo } });
    expect(xml).toContain('<sound tempo="138"/>');
    expect(xml).toContain('<beat-unit-dot/>');
    expect(musicXmlToScore(xml).score.meta.tempo).toEqual(tempo);
  });
});
