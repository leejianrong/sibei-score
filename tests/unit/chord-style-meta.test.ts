import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { nastyChart } from '@sibei/fixtures';
import { CHORD_STYLE_PRESETS, projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { renderScorePages } from '@sibei/ui';

/** The per-score chord symbology (SIB2-163): meta.set, the render, and surface parity. */

const create: Operation = { type: 'score.create', payload: { id: 'chart', title: 'T', barCount: 4 } };
const withStyle = (chordStyle: Score['meta']['chordStyle']): Score => {
  const base = nastyChart();
  return chordStyle === undefined ? base : { ...base, meta: { ...base.meta, chordStyle } };
};

describe('meta.set --chord-style', () => {
  it('sets, clears with standard, validates, and replays', () => {
    const a = applyOperation(null, create);
    const b = applyOperation(a.score, { type: 'meta.set', payload: { chordStyle: 'real-book' } });
    expect(b.score.meta.chordStyle).toBe('real-book');
    expect(projectScore(b.score)).toContain('chord style: real-book');
    expect(replay([a.operation, b.operation])).toEqual(b.score);
    const c = applyOperation(b.score, { type: 'meta.set', payload: { chordStyle: 'standard' } });
    expect('chordStyle' in c.score.meta).toBe(false);
    expect(() =>
      applyOperation(a.score, { type: 'meta.set', payload: { chordStyle: 'bogus' as never } }),
    ).toThrow(OperationError);
  });

  it('leaves the default render untouched and changes it for every other preset', () => {
    const plain = renderScoreToSvg(withStyle(undefined)).map((p) => p.svg);
    expect(renderScoreToSvg(withStyle('standard')).map((p) => p.svg)).toEqual(plain);
    for (const preset of CHORD_STYLE_PRESETS.filter((p) => p !== 'standard')) {
      expect(renderScoreToSvg(withStyle(preset)).map((p) => p.svg)).not.toEqual(plain);
    }
  });

  it('draws the same bytes in the browser and on the server, per preset', () => {
    for (const preset of CHORD_STYLE_PRESETS) {
      const score = withStyle(preset);
      expect(renderScorePages(score).map((p) => p.svg)).toEqual(renderScoreToSvg(score).map((p) => p.svg));
    }
  });
});
