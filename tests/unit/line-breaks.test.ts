import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { aabaChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';
import { renderScorePages } from '@sibei/ui';

/** Line breaking off the four-bar grid (SIB2-174): `break.set|rm`, `meta.set barsPerSystem`. */

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

const create: Operation = { type: 'score.create', payload: { id: 'c', barCount: 12 } };
const section = (bar: number, letter: string): Operation => ({
  type: 'section.set',
  target: `bar${bar}`,
  payload: { letter },
});
/** Bars per system, as laid out. */
const shape = (score: Score) => layout(score).pages.flatMap((p) => p.systems.map((s) => s.bars.length));

describe('the default is the grid', () => {
  it('lays out 4/4/4 with no overrides, and sections still break', () => {
    expect(shape(run([create]).score)).toEqual([4, 4, 4]);
    expect(shape(run([create, section(3, 'A')]).score)).toEqual([2, 4, 4, 2]);
  });
});

describe('break.set after', () => {
  it('ends the line after bar 6, and the grid carries on from there', () => {
    expect(shape(run([create, { type: 'break.set', target: 'bar6' }]).score)).toEqual([4, 2, 4, 2]);
    expect(shape(run([create, { type: 'break.set', target: 'bar3' }]).score)).toEqual([3, 4, 4, 1]);
  });

  it('can be removed again, and the layout returns to the grid', () => {
    const { score } = run([create, { type: 'break.set', target: 'bar6' }, { type: 'break.rm', target: 'bar6' }]);
    expect(shape(score)).toEqual([4, 4, 4]);
    expect(Object.keys(score.bars[5]!)).not.toContain('lineBreak');
  });

  it('says so when there is nothing to remove', () => {
    expect(() => run([create, { type: 'break.rm', target: 'bar2' }])).toThrow(/nothing to remove/);
  });

  it('replays', () => {
    const { score, log } = run([create, { type: 'break.set', target: 'bar6' }, { type: 'break.set', target: 'bar2' }]);
    expect(replay(log)).toEqual(score);
  });
});

describe('break.set join', () => {
  it('lets a section share the intro line', () => {
    // Intro on bar 1, A from bar 3: by default A starts a new line.
    const base = [create, section(1, 'I'), section(3, 'A')];
    expect(shape(run(base).score)).toEqual([2, 4, 4, 2]);
    const joined = run([...base, { type: 'break.set', target: 'bar3', payload: { kind: 'join' } }]);
    expect(shape(joined.score)).toEqual([4, 4, 4]);
  });

  it('is refused on a bar that begins no section', () => {
    expect(() => run([create, { type: 'break.set', target: 'bar3', payload: { kind: 'join' } }])).toThrow(
      OperationError,
    );
  });

  it('refuses a break kind it does not know', () => {
    expect(() => run([create, { type: 'break.set', target: 'bar3', payload: { kind: 'before' } } as unknown as Operation])).toThrow(
      OperationError,
    );
  });
});

describe('meta.set barsPerSystem', () => {
  const per = (n: number | null): Operation => ({ type: 'meta.set', payload: { barsPerSystem: n } });

  it('changes the count, stores 4 as absent, and refuses nonsense', () => {
    expect(shape(run([create, per(3)]).score)).toEqual([3, 3, 3, 3]);
    expect(shape(run([create, per(6)]).score)).toEqual([6, 6]);
    const back = run([create, per(3), per(4)]).score;
    expect(Object.keys(back.meta)).not.toContain('barsPerSystem');
    for (const bad of [0, 9, 2.5]) expect(() => run([create, per(bad)])).toThrow(OperationError);
  });

  it('composes with a break: it fills to the count, then the override ends the line', () => {
    expect(shape(run([create, per(3), { type: 'break.set', target: 'bar2' }]).score)).toEqual([2, 3, 3, 3, 1]);
  });
});

describe('breaks elsewhere', () => {
  const chart = (): Score => run([create, per3(), { type: 'break.set', target: 'bar5' }]).score;
  function per3(): Operation {
    return { type: 'meta.set', payload: { barsPerSystem: 3 } };
  }

  it('show names them', () => {
    expect(projectScore(chart())).toContain('lines: 3 bars per line, break after bar5');
    expect(projectScore(run([create]).score)).not.toContain('lines:');
  });

  it('draws the same bytes in the browser and on the server', () => {
    const score = chart();
    expect(renderScorePages(score).map((p) => p.svg)).toEqual(renderScoreToSvg(score).map((p) => p.svg));
  });

  it('keeps the default render of a chart without overrides byte-identical', () => {
    const plain = aabaChart();
    expect(renderScoreToSvg(plain)).toEqual(renderScoreToSvg(JSON.parse(JSON.stringify(plain)) as Score));
  });

  it('round-trips a break through MusicXML <print new-system>, not the join or the count', () => {
    const xml = scoreToMusicXml(run([create, { type: 'break.set', target: 'bar6' }]).score);
    expect(xml).toContain('<print new-system="yes"/>');
    const back = musicXmlToScore(xml).score;
    expect(back.bars.filter((b) => b.lineBreak !== undefined).map((b) => [b.number, b.lineBreak])).toEqual([[6, 'after']]);
    expect(scoreToMusicXml(run([create]).score)).not.toContain('<print');
  });
});
