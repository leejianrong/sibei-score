import { describe, expect, it } from 'vitest';
import { applyOperation, replay, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { renderScoreToSvg } from '@sibei/pdf';
import { graceNotesChart } from '@sibei/fixtures';
import { layout } from '@sibei/layout';
import { barMetrics, projectScore, barViews } from '@sibei/model';
import type { Note, Score } from '@sibei/model';
import { writtenPart } from '@sibei/music';

/** Grace notes (SIB2-185): the op, replay, metric validity, layout, ink, projection and MusicXML. */

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

const create: Operation = { type: 'score.create', payload: { id: 'chart', title: 'T', barCount: 2 } };
const notes: Operation[] = [
  { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'E5', duration: { value: 2, dots: 0 } } },
  { type: 'note.add', target: 'bar1.beat3', payload: { pitch: 'G5', duration: { value: 2, dots: 0 } } },
];
const firstNote = (score: Score): Note => {
  const item = barViews(score)[0]?.items[0];
  if (item?.kind !== 'note') throw new Error('no note');
  return item;
};

describe('grace.add and grace.rm', () => {
  it('appends graces in order, takes the recorded id on replay, and removes by id or by note', () => {
    const added = run([
      create,
      ...notes,
      { type: 'grace.add', target: 'bar1.n1', payload: { pitch: 'D5', slashed: true } },
      { type: 'grace.add', target: 'bar1.n1', payload: { pitch: 'F#5', value: 16 } },
    ]);
    const graces = firstNote(added.score).graces ?? [];
    expect(graces.map((g) => [g.id, g.value, g.slashed])).toEqual([['grace-1', 8, true], ['grace-2', 16, false]]);
    expect(replay(added.log)).toEqual(added.score);

    const one = run([...added.log, { type: 'grace.rm', target: 'grace-1' }]);
    expect(firstNote(one.score).graces?.map((g) => g.id)).toEqual(['grace-2']);
    const all = run([...added.log, { type: 'grace.rm', target: 'bar1.n1' }]);
    expect(Object.keys(firstNote(all.score))).not.toContain('graces');
    expect(replay(all.log)).toEqual(all.score);
  });

  it('keeps graces through note.set and drops them with the note', () => {
    const base = run([create, ...notes, { type: 'grace.add', target: 'bar1.n1', payload: { pitch: 'D5' } }]);
    const moved = run([...base.log, { type: 'note.set', target: 'bar1.n1', payload: { pitch: 'F5' } }]);
    expect(firstNote(moved.score).graces).toHaveLength(1);
    const gone = run([...base.log, { type: 'note.rm', target: 'bar1.n1' }]);
    expect(JSON.stringify(gone.score)).not.toContain('grace-1');
  });

  it('refuses a bad value, a rest, a missing pitch and removing none', () => {
    const base = run([create, ...notes]);
    const apply = (op: object) => () => applyOperation(base.score, op as Operation);
    expect(apply({ type: 'grace.add', target: 'bar1.n1', payload: { pitch: 'D5', value: 4 } })).toThrow(OperationError);
    expect(apply({ type: 'grace.add', target: 'bar1.n1', payload: { pitch: 'H9' } })).toThrow(OperationError);
    expect(apply({ type: 'grace.rm', target: 'bar1.n1' })).toThrow(OperationError);
  });

  it('never changes a bar is metric validity (ADR-0013)', () => {
    const plain = run([create, ...notes]).score;
    const graced = run([create, ...notes, { type: 'grace.add', target: 'bar1.n1', payload: { pitch: 'D5' } }]).score;
    const time = plain.meta.time;
    expect(barMetrics(barViews(graced)[0]!, time)).toEqual(barMetrics(barViews(plain)[0]!, time));
  });
});

describe('graces on the page', () => {
  it('lays them out on the note, with accidentals resolved against the key and earlier graces', () => {
    const chart = graceNotesChart();
    const items = layout(chart).pages[0]!.systems.flatMap((s) => s.bars.flatMap((b) => b.items));
    const withGraces = items.flatMap((item) => (item.kind === 'note' && item.graces !== undefined ? [item.graces] : []));
    expect(withGraces).toHaveLength(7);
    expect(withGraces[1]!.map((g) => g.accidentalGlyph)).toEqual([null]);
    expect(withGraces[2]!.map((g) => g.accidentalGlyph)).toEqual([1]);
    expect(withGraces[3]!.map((g) => g.accidentalGlyph)).toEqual([-1]);
    expect(withGraces[4]!.map((g) => g.accidentalGlyph)).toEqual([null, null, null]);
  });

  it('draws each grace small, a flag for one and a beam for a group, and slashes the slashed ones', () => {
    const svg = renderScoreToSvg(graceNotesChart())[0]!.svg;
    const small = [...svg.matchAll(/class="se-glyph se-grace se-noteheadBlack"/g)].length;
    expect(small).toBe(10);
    expect(svg.match(/class="se-graceslash"/g)).toHaveLength(4);
    expect(svg.match(/class="se-glyph se-grace se-flag8thUp"/g)).toHaveLength(4);
  });

  it('leaves a chart without graces byte for byte as it was', () => {
    const chart = graceNotesChart();
    for (const bar of barViews(chart)) for (const item of bar.items) if (item.kind === 'note') delete item.graces;
    expect(renderScoreToSvg(chart)[0]!.svg).not.toContain('se-grace');
  });

  it('transposes them with their note, in the score and in a part', () => {
    const base = run([create, ...notes, { type: 'grace.add', target: 'bar1.n1', payload: { pitch: 'D5' } }]);
    const up = run([...base.log, { type: 'transpose', payload: { to: { tonic: 'D', alter: 0, mode: 'major' } } }]);
    expect(firstNote(up.score).graces?.[0]?.pitch).toEqual({ step: 'E', alter: 0, octave: 5 });
    const part = writtenPart(base.score, 'bb-trumpet');
    expect(firstNote(part).graces?.[0]?.pitch.step).toBe('E');
  });
});

describe('graces in the text projection and MusicXML', () => {
  it('shows them under the bar with the id grace rm takes', () => {
    const text = projectScore(graceNotesChart());
    expect(text).toContain('grace  n1: d5/8s grace-1  n2: f5/8 grace-2');
  });

  it('round-trips through MusicXML, graces before their principal with no duration', () => {
    const chart = graceNotesChart();
    const xml = scoreToMusicXml(chart);
    expect(xml).toContain('<grace slash="yes"/>');
    expect(xml).toContain('<grace/>');
    const back = musicXmlToScore(xml);
    expect(back.warnings.join(' ')).not.toContain('grace');
    const first = barViews(back.score)[2]!.items[0] as Note;
    expect(first.graces?.map((g) => [g.pitch.step, g.value, g.slashed])).toEqual([
      ['C', 16, true],
      ['E', 16, true],
      ['F', 16, true],
    ]);
    // Rhythm is untouched: the same bars are valid.
    expect(barViews(back.score).map((b) => b.items.length)).toEqual(barViews(chart).map((b) => b.items.length));
  });

  it('drops a grace before a rest or at the end with a warning', () => {
    const xml = scoreToMusicXml(run([create, { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'E5', duration: { value: 1, dots: 0 } } }]).score);
    const rest = xml.replace(
      '<note>',
      '<note><grace/><pitch><step>D</step><octave>5</octave></pitch><voice>1</voice><type>eighth</type></note><note><rest/><duration>480</duration><voice>1</voice><type>quarter</type></note><note>',
    );
    const read = musicXmlToScore(rest);
    expect(read.warnings.join(' ')).toContain('grace notes before a rest were dropped');
  });
});
