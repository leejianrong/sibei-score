import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { articulationsChart } from '@sibei/fixtures';
import { projectScore, barViews } from '@sibei/model';
import type { Score } from '@sibei/model';
import { renderScoreToSvg } from '@sibei/pdf';

/** Articulations (SIB2-179): staccato, accent and marcato as an optional list on a note. */

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

const create: Operation = { type: 'score.create', payload: { id: 'chart', barCount: 2 } };
const add = (articulations?: string[]): Operation =>
  ({
    type: 'note.add',
    target: 'bar1.beat1',
    payload: { pitch: 'C5', duration: { value: 4, dots: 0 }, ...(articulations === undefined ? {} : { articulations }) },
  }) as Operation;
const set = (articulations: string[]): Operation =>
  ({ type: 'note.set', target: 'bar1.n1', payload: { articulations } }) as Operation;
const marks = (score: Score): unknown => (barViews(score)[0]!.items[0] as { articulations?: string[] }).articulations;

describe('articulations on note.add and note.set', () => {
  it('stores marks in stacking order without repeats, and absent when none', () => {
    expect(marks(run([create, add(['marcato', 'staccato', 'staccato'])]).score)).toEqual(['staccato', 'marcato']);
    expect('articulations' in barViews(run([create, add()]).score)[0]!.items[0]!).toBe(false);
    expect('articulations' in barViews(run([create, add([])]).score)[0]!.items[0]!).toBe(false);
  });

  it('note.set replaces them, an empty list clears them, and omitting leaves them be', () => {
    const marked = run([create, add(['accent'])]);
    expect(marks(run([...marked.log, set(['staccato'])]).score)).toEqual(['staccato']);
    expect('articulations' in barViews(run([...marked.log, set([])]).score)[0]!.items[0]!).toBe(false);
    const pitched = run([
      ...marked.log,
      { type: 'note.set', target: 'bar1.n1', payload: { pitch: 'D5' } } as Operation,
    ]);
    expect(marks(pitched.score)).toEqual(['accent']);
    expect(replay(pitched.log)).toEqual(pitched.score);
  });

  it('refuses a name that is not a mark', () => {
    const base = run([create, add()]).score;
    expect(() => applyOperation(base, set(['fall']))).toThrow(OperationError);
    expect(() => applyOperation(base, set(['fall']))).toThrow(/not an articulation/);
  });

  it('shows as :stac :acc :mar in the text projection', () => {
    const { score } = run([create, add(['staccato', 'accent'])]);
    expect(projectScore(score)).toContain('n1 c5/4:stac:acc');
  });
});

describe('articulation drawing and MusicXML', () => {
  it('draws one glyph per mark, below for up stems and above for down stems', () => {
    const svg = renderScoreToSvg(articulationsChart())
      .map((page) => page.svg)
      .join('');
    // 21 marks in the fixture: 4 in bar 1, 5 in bar 2, 7 in bar 3 (two of them stacks), 5 in bar 4.
    expect(svg.match(/se-artic/g)).toHaveLength(21);
    expect(svg).toMatch(/se-articStaccatoAbove/);
    expect(svg).toMatch(/se-articStaccatoBelow/);
    expect(svg).toMatch(/se-articMarcatoAbove/);
    expect(svg).toMatch(/se-articAccentBelow/);
  });

  it('round-trips marks through <articulations>, marcato as the strong accent', () => {
    const { score } = run([create, add(['staccato', 'accent', 'marcato'])]);
    const xml = scoreToMusicXml(score);
    for (const tag of ['<staccato/>', '<accent/>', '<strong-accent type="up"/>']) expect(xml).toContain(tag);
    const back = musicXmlToScore(xml, { id: 'chart' });
    expect(marks(back.score)).toEqual(['staccato', 'accent', 'marcato']);
    expect(back.warnings).toEqual([]);
  });

  it('says so when a file carries an articulation it cannot keep', () => {
    const xml = scoreToMusicXml(run([create, add()]).score).replace(
      '<voice>1</voice>',
      '<voice>1</voice>',
    );
    const withTenuto = xml.replace('</note>', '<notations><articulations><tenuto/></articulations></notations></note>');
    const back = musicXmlToScore(withTenuto, { id: 'chart' });
    expect(back.warnings.join(' ')).toContain('tenuto');
  });
});
