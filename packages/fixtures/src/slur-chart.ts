import type { BarView, Score } from '@sibei/model';
import { createIdFactory, dur, makeScore } from '@sibei/model';
import { BarBuilder } from './builder.js';
import type { BarSpec } from './builder.js';

/**
 * The slur proofing chart (SIB2-168): eight bars, two lines, every placement rule visible.
 *
 * - bar 1: a run of down-stemmed notes (high), slurred above — the notehead side is up
 * - bar 2: a run of up-stemmed notes (low), slurred below
 * - bar 3: a mixed run over the middle line, slurred across the barline into bar 4
 * - bar 4 into bar 5: a slur that **crosses the system break**, so it draws as two halves
 * - bar 6: a leap that must arch over the high note, under a chord symbol
 * - bar 7: a slur whose placement the score chose (below, against the stems), over a tied pair
 * - bar 8: a long slur over eight eighth notes
 */
export function slurChart(): Score {
  const ids = createIdFactory();
  const make = (spec: BarSpec): BarBuilder => new BarBuilder(ids, spec);
  const bars: BarView[] = [
    make({ number: 1 }).chord(1, 'Cmaj7', 480).note('A5', dur(4)).note('G5', dur(4)).note('F5', dur(4)).note('E5', dur(4)).build(),
    make({ number: 2 }).chord(1, 'Dm7', 480).note('C4', dur(4)).note('D4', dur(4)).note('E4', dur(4)).note('F4', dur(4)).build(),
    make({ number: 3 }).chord(1, 'G7', 480).note('E4', dur(4)).note('B4', dur(4)).note('D5', dur(4)).note('C5', dur(4)).build(),
    make({ number: 4 }).chord(1, 'Cmaj7', 480).note('E5', dur(2)).note('G5', dur(2)).build(),
    make({ number: 5 }).chord(1, 'Am7', 480).note('A5', dur(2)).note('F5', dur(2)).build(),
    make({ number: 6 }).chord(1, 'Fmaj7', 480).note('C5', dur(4)).note('C6', dur(4)).note('A5', dur(4)).note('F5', dur(4)).build(),
    make({ number: 7 }).chord(1, 'Bb7', 480).note('F5', dur(4)).note('G5', dur(4), 'start').note('G5', dur(4), 'stop').note('A5', dur(4)).build(),
    make({ number: 8, endBarline: 'final' })
      .chord(1, 'Cmaj7', 480)
      .note('C5', dur(8)).note('D5', dur(8)).note('E5', dur(8)).note('F5', dur(8))
      .note('G5', dur(8)).note('F5', dur(8)).note('E5', dur(8)).note('D5', dur(8))
      .build(),
  ];
  const score = makeScore({ id: 'slur-chart', title: 'Slurs', composer: 'Proof chart', bars });
  const at = (bar: number, n: number): string => {
    const item = bars[bar - 1]?.items[n - 1];
    if (item === undefined) throw new Error(`no item bar${bar}.n${n}`);
    return item.id;
  };
  const slur = (id: number, from: [number, number], to: [number, number], placement?: 'above' | 'below') => ({
    id: `slur-${id}`,
    kind: 'slur' as const,
    startId: at(...from),
    endId: at(...to),
    ...(placement === undefined ? {} : { placement }),
  });
  score.spanners = [
    slur(1, [1, 1], [1, 4]),
    slur(2, [2, 1], [2, 4]),
    slur(3, [3, 1], [4, 1]),
    slur(4, [4, 2], [5, 1]),
    slur(5, [6, 1], [6, 4]),
    slur(6, [7, 1], [7, 4], 'below'),
    slur(7, [8, 1], [8, 8]),
  ];
  return score;
}
