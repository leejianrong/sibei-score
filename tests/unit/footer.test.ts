import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { longFormChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { renderScorePages } from '@sibei/ui';

/** The page footer (SIB2-172): meta.set, the layout, the projection and the MusicXML round trip. */

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
const withFooter = (text: string, pages: 'first' | 'last' | 'all' = 'all'): Score => ({
  ...longFormChart(),
  meta: { ...longFormChart().meta, footer: { text, pages } },
});

describe('meta.set --footer', () => {
  it('sets, re-targets and clears the footer, and replays', () => {
    const set = run([create, { type: 'meta.set', payload: { footer: '© 2026 Someone' } }]);
    expect(set.score.meta.footer).toEqual({ text: '© 2026 Someone', pages: 'all' });

    const moved = run([...set.log, { type: 'meta.set', payload: { footerPages: 'last' } }]);
    expect(moved.score.meta.footer).toEqual({ text: '© 2026 Someone', pages: 'last' });
    expect(replay(moved.log)).toEqual(moved.score);

    const cleared = run([...moved.log, { type: 'meta.set', payload: { footer: null } }]);
    expect(cleared.score.meta.footer).toBeUndefined();
    expect(Object.keys(cleared.score.meta)).not.toContain('footer');
  });

  it('leaves the footer alone when other meta changes', () => {
    const { score } = run([create, { type: 'meta.set', payload: { footer: 'x' } }, { type: 'meta.set', payload: { title: 'U' } }]);
    expect(score.meta.footer?.text).toBe('x');
  });

  it('refuses a bad page choice, a footer-less retarget and an overlong footer', () => {
    const base = run([create]);
    const apply = (payload: object) => () =>
      applyOperation(base.score, { type: 'meta.set', payload } as Operation);
    expect(apply({ footer: 'x', footerPages: 'middle' })).toThrow(OperationError);
    expect(apply({ footerPages: 'last' })).toThrow(OperationError);
    expect(apply({ footer: 'x'.repeat(501) })).toThrow(OperationError);
  });
});

describe('the footer on the page', () => {
  it('prints on the pages it is set for', () => {
    const pagesWith = (pages: 'first' | 'last' | 'all') =>
      layout(withFooter('© Someone', pages)).pages.map((p) => p.furniture.filter((f) => f.role === 'footer').length);
    expect(pagesWith('all')).toEqual([1, 1]);
    expect(pagesWith('first')).toEqual([1, 0]);
    expect(pagesWith('last')).toEqual([0, 1]);
  });

  it('wraps within the margins, honours \\n, and keeps clear of the systems', () => {
    const text = `${'a long credit line '.repeat(20).trim()}\nsecond paragraph`;
    const result = layout(withFooter(text));
    const { pageSpec } = result;
    const lines = result.pages[0]!.furniture.filter((f) => f.role === 'footer');
    expect(lines.length).toBeGreaterThan(2);
    expect(lines.at(-1)!.text).toBe('second paragraph');
    // No line is longer than the measure allows (the estimate is the layout's own).
    const perLine = Math.floor((pageSpec.width - pageSpec.margin.left - pageSpec.margin.right) / (12 * 0.6));
    for (const line of lines) expect(line.text.length).toBeLessThanOrEqual(perLine);
    // Every system ends above the first footer baseline.
    const top = lines[0]!.y - 12;
    for (const page of result.pages) for (const s of page.systems) expect(s.y + s.height).toBeLessThanOrEqual(top);
  });

  it('draws the same bytes in the browser and on the server', () => {
    const score = withFooter('© 2026 Someone · all rights reserved');
    expect(renderScorePages(score).map((p) => p.svg)).toEqual(renderScoreToSvg(score).map((p) => p.svg));
    expect(renderScoreToSvg(score)[0]!.svg).toContain('se-footer');
  });

  it('changes nothing for a chart without one', () => {
    expect(layout(longFormChart()).pages.every((p) => p.furniture.length === 0)).toBe(true);
  });
});

describe('the footer elsewhere', () => {
  it('is in the text projection', () => {
    expect(projectScore(withFooter('© Someone', 'last'))).toContain('footer (last pages): "© Someone"');
    expect(projectScore(longFormChart())).not.toContain('footer');
  });

  it('round-trips through MusicXML <rights>, losing only which pages', () => {
    const xml = scoreToMusicXml(withFooter('© Someone', 'first'));
    expect(xml).toContain('<rights>© Someone</rights>');
    expect(musicXmlToScore(xml).score.meta.footer).toEqual({ text: '© Someone', pages: 'all' });
    expect(musicXmlToScore(scoreToMusicXml(longFormChart())).score.meta.footer).toBeUndefined();
  });
});
