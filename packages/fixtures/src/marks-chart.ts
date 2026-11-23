import type { BarView, BarItem, Score } from '@sibei/model';
import { createIdFactory, dur, makeScore } from '@sibei/model';
import { BarBuilder } from './builder.js';
import type { BarSpec } from './builder.js';

/**
 * The marks proofing chart (SIB2-183, later SIB2-179): the signs that sit over or under a note.
 *
 * - bar 1: a fermata over a low up-stemmed note, a high down-stemmed one, and a rest, under chord symbols
 * - bar 2: a fermata over a note reaching above the staff (it must clear the ledger lines and the chord)
 * - bar 3: a fermata on the last note of a line, then bar 4's final barline
 */
export function marksChart(): Score {
  const ids = createIdFactory();
  const make = (spec: BarSpec): BarBuilder => new BarBuilder(ids, spec);
  const bars: BarView[] = [
    make({ number: 1 }).chord(1, 'Dm7', 480).note('D4', dur(4)).note('A5', dur(4)).rest(dur(4)).note('G4', dur(4)).build(),
    make({ number: 2 }).chord(1, 'G7', 480).note('C6', dur(2)).note('B4', dur(2)).build(),
    make({ number: 3 }).chord(1, 'Cmaj7', 480).note('E5', dur(2)).note('C5', dur(2)).build(),
    make({ number: 4, endBarline: 'final' }).chord(1, 'Cmaj7', 480).note('G4', dur(1)).build(),
  ];
  const at = (bar: number, n: number): BarItem => {
    const item = bars[bar - 1]?.items[n - 1];
    if (item === undefined) throw new Error(`no item bar${bar}.n${n}`);
    return item;
  };
  for (const [bar, n] of [[1, 1], [1, 2], [1, 3], [2, 1], [4, 1]] as const) at(bar, n).fermata = true;
  return makeScore({ id: 'marks-chart', title: 'Marks', composer: 'Proof chart', bars });
}
