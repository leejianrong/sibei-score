import { describe, expect, it } from 'vitest';
import { applyOperation, OperationError } from '@sibei/api';
import type { Operation } from '@sibei/api';
import { musicXmlToScore, scoreToMusicXml } from '@sibei/codec';
import { layout } from '@sibei/layout';
import type { Score } from '@sibei/model';

/** The `parens` accidental display (SIB2-182): accepted by both note ops, drawn by layout, kept by MusicXML. */

const quarter = { value: 4, dots: 0 } as const;

function build(accidental: string): Score {
  const ops: Operation[] = [
    { type: 'score.create', payload: { id: 'c', barCount: 2 } },
    { type: 'note.add', target: 'bar1.beat1', payload: { pitch: 'F#5', duration: quarter, accidental } as never },
  ];
  let score: Score | null = null;
  for (const op of ops) score = applyOperation(score, op).score;
  return score!;
}

describe('parens accidental', () => {
  it('is accepted by note.add and note.set and refuses unknown displays', () => {
    const score = build('parens');
    expect((score.bars[0]!.items[0] as { accidental: string }).accidental).toBe('parens');
    const set = applyOperation(build('auto'), {
      type: 'note.set',
      target: 'bar1.beat1',
      payload: { accidental: 'parens' },
    });
    expect((set.score.bars[0]!.items[0] as { accidental: string }).accidental).toBe('parens');
    expect(() => build('cautionary')).toThrow(OperationError);
  });

  it('draws the accidental in layout even where the key would not', () => {
    const score = build('parens');
    const note = layout(score).pages[0]!.systems[0]!.bars[0]!.items.find((i) => i.kind === 'note');
    expect(note).toMatchObject({ accidental: 'parens', accidentalGlyph: 1 });
  });

  it('survives a MusicXML round trip as parentheses="yes"', () => {
    const xml = scoreToMusicXml(build('parens'));
    expect(xml).toContain('parentheses="yes"');
    const back = musicXmlToScore(xml).score;
    const note = back.bars.flatMap((b) => b.items).find((i) => i.kind === 'note') as { accidental: string };
    expect(note.accidental).toBe('parens');
  });
});
