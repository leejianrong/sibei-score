import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { titleBlockChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { projectScore } from '@sibei/model';
import type { Score } from '@sibei/model';

/** Subtitle, arranger and a second composer line (SIB2-180): meta.set, layout, projection and MusicXML. */

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

const create: Operation = { type: 'score.create', payload: { id: 'chart', title: 'T', composer: 'A', barCount: 4 } };

describe('meta.set --subtitle --arranger', () => {
  it('sets and clears both, leaves them alone otherwise, and replays', () => {
    const set = run([create, { type: 'meta.set', payload: { subtitle: 'Sub', arranger: 'Arr' } }]);
    expect(set.score.meta.subtitle).toBe('Sub');
    expect(set.score.meta.arranger).toBe('Arr');
    const other = run([...set.log, { type: 'meta.set', payload: { title: 'U' } }]);
    expect(other.score.meta.subtitle).toBe('Sub');
    expect(replay(other.log)).toEqual(other.score);
    const cleared = run([...other.log, { type: 'meta.set', payload: { subtitle: null, arranger: '  ' } }]);
    expect(Object.keys(cleared.score.meta)).not.toContain('subtitle');
    expect(Object.keys(cleared.score.meta)).not.toContain('arranger');
  });

  it('refuses an overlong line', () => {
    const base = run([create]);
    expect(() => applyOperation(base.score, { type: 'meta.set', payload: { subtitle: 'x'.repeat(201) } })).toThrow(OperationError);
  });
});

describe('the title block', () => {
  it('draws a subtitle under the title and stacks composer lines then the arranger down the right', () => {
    const header = layout(titleBlockChart()).pages[0]?.header ?? [];
    expect(header.map((text) => text.role)).toEqual(['title', 'subtitle', 'style', 'composer', 'composer', 'arranger']);
    const [title, subtitle, , c1, c2, arr] = header;
    expect(subtitle!.y).toBeGreaterThan(title!.y);
    expect(c2!.y).toBeGreaterThan(c1!.y);
    expect(arr!.y).toBeGreaterThan(c2!.y);
    expect(arr!.align).toBe('right');
  });

  it('leaves a chart without them exactly as before', () => {
    const plain = titleBlockChart();
    plain.meta = { ...plain.meta, composer: 'One' };
    delete plain.meta.subtitle;
    delete plain.meta.arranger;
    const header = layout(plain).pages[0]?.header ?? [];
    expect(header.map((text) => text.role)).toEqual(['title', 'style', 'composer']);
  });

  it('shows them in the text projection', () => {
    const text = projectScore(titleBlockChart());
    expect(text).toContain('subtitle: "a subtitle in italics"');
    expect(text).toContain('arranger: "Arr. Someone Else"');
    expect(text).toContain('First Composer / Second Composer');
  });

  it('round-trips through MusicXML', () => {
    const score = titleBlockChart();
    const xml = scoreToMusicXml(score);
    expect(xml).toContain('<movement-title>a subtitle in italics</movement-title>');
    expect(xml).toContain('type="arranger"');
    const back = musicXmlToScore(xml).score;
    expect(back.meta.subtitle).toBe(score.meta.subtitle);
    expect(back.meta.arranger).toBe(score.meta.arranger);
    expect(back.meta.composer).toBe(score.meta.composer);
  });
});
