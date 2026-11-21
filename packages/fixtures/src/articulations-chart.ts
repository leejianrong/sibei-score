import type { Bar, BarItem, Score } from '@sibei/model';
import { createIdFactory, dur, makeScore } from '@sibei/model';
import type { Articulation } from '@sibei/model';
import { BarBuilder } from './builder.js';
import type { BarSpec } from './builder.js';

/**
 * The articulation proofing chart (SIB2-179): staccato, accent and marcato on the notehead side, by stem.
 *
 * - bar 1: each mark alone on a down-stemmed note inside the staff (above the head, in the space)
 * - bar 2: each mark alone on an up-stemmed low note (below the head)
 * - bar 3: stacked marks (staccato and accent; all three) and a mark on a note off the staff, high and low
 * - bar 4: marks on beamed eighths, and a staccato under a fermata and a chord symbol
 */
export function articulationsChart(): Score {
  const ids = createIdFactory();
  const make = (spec: BarSpec): BarBuilder => new BarBuilder(ids, spec);
  const bars: Bar[] = [
    make({ number: 1 }).chord(1, 'Dm7', 480).note('A4', dur(4)).note('B4', dur(4)).note('C5', dur(4)).note('D5', dur(4)).build(),
    make({ number: 2 }).chord(1, 'G7', 480).note('E4', dur(4)).note('F4', dur(4)).note('G4', dur(4)).note('A4', dur(4)).build(),
    make({ number: 3 }).chord(1, 'Cmaj7', 480).note('C5', dur(4)).note('C5', dur(4)).note('A5', dur(4)).note('C4', dur(4)).build(),
    make({ number: 4, endBarline: 'final' })
      .chord(1, 'Cmaj7', 480)
      .note('E5', dur(8)).note('D5', dur(8)).note('E5', dur(8)).note('D5', dur(8))
      .note('G5', dur(4)).note('C5', dur(4))
      .build(),
  ];
  const mark = (bar: number, n: number, marks: Articulation[]): void => {
    const item: BarItem | undefined = bars[bar - 1]?.items[n - 1];
    if (item === undefined || item.kind !== 'note') throw new Error(`no note bar${bar}.n${n}`);
    item.articulations = marks;
  };
  // Bar 1: A4 has its stem up, so its mark goes below; B4, C5 and D5 have stems down, so theirs go above.
  mark(1, 1, ['staccato']);
  mark(1, 2, ['accent']);
  mark(1, 3, ['marcato']);
  mark(1, 4, ['staccato']);
  mark(2, 1, ['staccato']);
  mark(2, 2, ['accent']);
  mark(2, 3, ['marcato']);
  mark(2, 4, ['staccato', 'accent']);
  mark(3, 1, ['staccato', 'accent']);
  mark(3, 2, ['staccato', 'accent', 'marcato']);
  mark(3, 3, ['staccato']);
  mark(3, 4, ['accent']);
  mark(4, 1, ['staccato']);
  mark(4, 2, ['staccato']);
  mark(4, 3, ['staccato']);
  mark(4, 4, ['staccato']);
  mark(4, 5, ['accent']);
  const held = bars[3]?.items[5];
  if (held !== undefined) held.fermata = true;
  return makeScore({ id: 'articulations-chart', title: 'Articulations', composer: 'Proof chart', bars });
}
