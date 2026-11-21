import type { Bar, Score } from '@sibei/model';
import { createIdFactory, dur, makeScore } from '@sibei/model';
import { BarBuilder } from './builder.js';

/**
 * The full title block (SIB2-180): a title with a subtitle under it, a style line at the left, and two composer
 * lines and an arranger line stacked down the right. Invented text, nothing from a real page.
 */
export function titleBlockChart(): Score {
  const ids = createIdFactory();
  const make = (number: number): BarBuilder => new BarBuilder(ids, { number });
  const bars: Bar[] = [
    make(1).chord(1, 'Dm7', 480).note('D5', dur(2)).note('F5', dur(2)).build(),
    make(2).chord(1, 'G7', 480).note('G5', dur(1)).build(),
    make(3).chord(1, 'Cmaj7', 480).note('E5', dur(1)).build(),
    new BarBuilder(ids, { number: 4, endBarline: 'final' }).chord(1, 'Cmaj7', 480).note('C5', dur(1)).build(),
  ];
  const score = makeScore({
    id: 'title-block-chart',
    title: 'Title Block',
    composer: 'First Composer\nSecond Composer',
    style: 'Medium swing',
    bars,
  });
  score.meta.subtitle = 'a subtitle in italics';
  score.meta.arranger = 'Arr. Someone Else';
  return score;
}
